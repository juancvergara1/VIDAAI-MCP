/**
 * Baileys Provider — Local WebSocket to WhatsApp via @whiskeysockets/baileys.
 * Personal WhatsApp, pairing code auth, real-time message push, groups support.
 *
 * Messages arrive in real-time via WebSocket events and are written to DB immediately.
 * syncMessages() is a no-op since messages are push-based.
 *
 * CRITICAL: All logging goes to stderr. Never use console.log() — corrupts MCP stdio.
 */

import type { IWhatsAppProvider, SendResult, MediaMessage } from "./types.js";
import { readFileSync, existsSync } from "fs";
import type { UserDb } from "../db/index.js";
import {
  upsertContact,
  upsertConversation,
  insertMessage,
  updateConversationAfterMessage,
  updateContactLastMessage,
} from "../tools/sync-common.js";
import { resolve } from "path";
import { homedir } from "os";

export interface BaileysConfig {
  authDir: string;
}

export class BaileysProvider implements IWhatsAppProvider {
  private db: UserDb;
  private authDir: string;
  private sock: any = null;
  // Track message IDs sent via sendMessage() to avoid double-write in processMessage()
  private recentSentIds = new Set<string>();
  // Track unique conversations from historical sync (limit to 10)
  private historicalJids = new Set<string>();
  private static readonly MAX_HISTORICAL_CONVERSATIONS = 10;

  // Baileys modules (loaded once in init, reused in reconnect)
  private makeWASocket: any;
  private useMultiFileAuthState: any;
  private DisconnectReason: any;
  private logger: any;
  private waVersion: [number, number, number] | undefined;

  constructor(config: BaileysConfig, db: UserDb) {
    this.db = db;
    this.authDir = config.authDir.startsWith("~")
      ? resolve(homedir(), config.authDir.slice(2))
      : resolve(config.authDir);
  }

  async init(): Promise<void> {
    const baileys = await import("@whiskeysockets/baileys");
    this.makeWASocket = baileys.default;
    this.useMultiFileAuthState = baileys.useMultiFileAuthState;
    this.DisconnectReason = baileys.DisconnectReason;
    const pino = (await import("pino")).default;

    // CRITICAL: silent logger — Baileys/pino must NOT write to stdout
    this.logger = pino({ level: "silent" });

    // Fetch latest WA protocol version (avoids 405 errors)
    try {
      const v = await baileys.fetchLatestWaWebVersion({});
      this.waVersion = v.version;
    } catch { /* use Baileys default */ }

    // Wait for connection (with reconnect loop)
    await new Promise<void>((resolveInit, reject) => {
      let settled = false;

      // Persistent connection handler — survives reconnects
      this.onConnectionUpdate = async (update: any) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open" && !settled) {
          settled = true;
          console.error("[Baileys] Connected to WhatsApp.");
          resolveInit();
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== this.DisconnectReason.loggedOut;

          if (shouldReconnect) {
            console.error("[Baileys] Connection closed, reconnecting...");
            setTimeout(() => this.connect().catch((e: any) =>
              console.error("[Baileys] Reconnect failed:", e.message)), 2000);
          } else {
            console.error("[Baileys] Logged out. Run 'npx @vidaai/whatsapp-mcp setup' to reconnect.");
            if (!settled) {
              settled = true;
              reject(new Error("WhatsApp session logged out. Run setup again."));
            }
          }
        }
      };

      this.connect().catch((err) => {
        if (!settled) { settled = true; reject(err); }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Connection timeout. Check your internet or re-run setup."));
        }
      }, 30000);
    });
  }

  // Persistent connection.update handler — survives reconnects
  private onConnectionUpdate: ((update: any) => Promise<void>) | null = null;

  /**
   * Create a new socket connection and register all event handlers.
   * NO browser option — required for pairing code auth to work.
   */
  private async connect(): Promise<void> {
    const { state, saveCreds } = await this.useMultiFileAuthState(this.authDir);

    this.sock = this.makeWASocket({
      auth: state,
      logger: this.logger,
      ...(this.waVersion ? { version: this.waVersion } : {}),
    });

    this.sock.ev.on("creds.update", saveCreds);

    if (this.onConnectionUpdate) {
      this.sock.ev.on("connection.update", this.onConnectionUpdate);
    }

    // Handle incoming + historical messages — write to DB
    // "notify" = real-time new messages, "append" = historical sync
    this.sock.ev.on("messages.upsert", async (event: any) => {
      const { messages: msgs, type } = event;

      for (const msg of msgs) {
        try {
          // For historical sync, limit to MAX_HISTORICAL_CONVERSATIONS unique chats
          if (type === "append") {
            const jid = msg.key?.remoteJid || "";
            if (!this.historicalJids.has(jid)) {
              if (this.historicalJids.size >= BaileysProvider.MAX_HISTORICAL_CONVERSATIONS) continue;
              this.historicalJids.add(jid);
            }
          }
          await this.processMessage(msg);
        } catch (err: any) {
          console.error("[Baileys] Error processing message:", err.message);
        }
      }
    });
  }

  async syncMessages(): Promise<number> {
    return 0; // Baileys is push-based
  }

  async sendMessage(to: string, text: string): Promise<SendResult> {
    if (!this.sock) {
      return { success: false, error: "Not connected to WhatsApp." };
    }

    try {
      const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;

      const sent = await this.sock.sendMessage(jid, { text });
      const waMessageId = sent?.key?.id || null;

      // Track this ID so processMessage() skips the echo from Baileys
      if (waMessageId) {
        this.recentSentIds.add(waMessageId);
        setTimeout(() => this.recentSentIds.delete(waMessageId), 30000);
      }

      // Write outbound message to DB
      const phone = to.replace(/\D/g, "");
      const contact = await upsertContact(this.db, phone);
      const conversation = await upsertConversation(this.db, contact.id);
      await insertMessage(this.db, conversation.id, {
        direction: "outbound",
        content: text,
        waMessageId,
        timestamp: new Date(),
      });
      await updateConversationAfterMessage(this.db, conversation.id, text, new Date(), false);
      await updateContactLastMessage(this.db, contact.id, new Date());

      return { success: true, waMessageId: waMessageId || undefined };
    } catch (err: any) {
      console.error("[Baileys] Send error:", err.message);
      return { success: false, error: err.message };
    }
  }

  async sendMedia(to: string, media: MediaMessage): Promise<SendResult> {
    if (!this.sock) {
      return { success: false, error: "Not connected to WhatsApp." };
    }

    try {
      const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;

      // Load media from file path or URL
      let buffer: Buffer;
      if (media.source.startsWith("http://") || media.source.startsWith("https://")) {
        const res = await fetch(media.source);
        if (!res.ok) return { success: false, error: `Failed to fetch media: ${res.statusText}` };
        buffer = Buffer.from(await res.arrayBuffer());
      } else {
        if (!existsSync(media.source)) {
          return { success: false, error: `File not found: ${media.source}` };
        }
        buffer = readFileSync(media.source);
      }

      // Build message based on MIME type
      const mime = media.mimetype.toLowerCase();
      let msgContent: any;

      if (mime.startsWith("image/")) {
        msgContent = { image: buffer, mimetype: media.mimetype, caption: media.caption };
      } else if (mime.startsWith("video/")) {
        msgContent = { video: buffer, mimetype: media.mimetype, caption: media.caption };
      } else if (mime.startsWith("audio/")) {
        msgContent = { audio: buffer, mimetype: media.mimetype };
      } else {
        msgContent = { document: buffer, mimetype: media.mimetype, fileName: media.fileName || "file", caption: media.caption };
      }

      const sent = await this.sock.sendMessage(jid, msgContent);
      const waMessageId = sent?.key?.id || null;

      if (waMessageId) {
        this.recentSentIds.add(waMessageId);
        setTimeout(() => this.recentSentIds.delete(waMessageId), 30000);
      }

      // Write outbound message to DB
      const phone = to.replace(/\D/g, "");
      const contact = await upsertContact(this.db, phone);
      const conversation = await upsertConversation(this.db, contact.id);
      const mediaType = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
      await insertMessage(this.db, conversation.id, {
        direction: "outbound",
        content: media.caption || `[${mediaType}: ${media.fileName || "file"}]`,
        mediaType,
        waMessageId,
        timestamp: new Date(),
      });
      await updateConversationAfterMessage(this.db, conversation.id, media.caption || `[${mediaType}]`, new Date(), false);
      await updateContactLastMessage(this.db, contact.id, new Date());

      return { success: true, waMessageId: waMessageId || undefined };
    } catch (err: any) {
      console.error("[Baileys] Send media error:", err.message);
      return { success: false, error: err.message };
    }
  }

  async destroy(): Promise<void> {
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }
  }

  private async processMessage(msg: any): Promise<void> {
    if (!msg.message) return;
    if (msg.key?.remoteJid === "status@broadcast") return;

    const msgId = msg.key?.id;
    if (msgId && this.recentSentIds.has(msgId)) {
      this.recentSentIds.delete(msgId);
      return;
    }

    const remoteJid = msg.key?.remoteJid || "";
    const isGroup = remoteJid.endsWith("@g.us");
    const isFromMe = msg.key?.fromMe || false;

    const phone = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
    if (!phone) return;

    const content = this.extractMessageContent(msg);
    if (!content && !msg.message?.imageMessage && !msg.message?.audioMessage && !msg.message?.documentMessage && !msg.message?.videoMessage) {
      return;
    }

    let contactName: string | null = null;
    if (isGroup) {
      try {
        const groupMeta = await this.sock.groupMetadata(remoteJid);
        contactName = groupMeta?.subject || null;
      } catch { contactName = null; }
    } else {
      contactName = msg.pushName || null;
    }

    let mediaType: string | null = null;
    if (msg.message?.imageMessage) mediaType = "image";
    else if (msg.message?.audioMessage) mediaType = "audio";
    else if (msg.message?.videoMessage) mediaType = "video";
    else if (msg.message?.documentMessage) mediaType = "document";

    const direction = isFromMe ? "outbound" : "inbound";
    const timestamp = new Date((msg.messageTimestamp as number) * 1000);
    const waMessageId = msg.key?.id || null;

    const contact = await upsertContact(this.db, phone, contactName, contactName);
    const conversation = await upsertConversation(this.db, contact.id);

    const inserted = await insertMessage(this.db, conversation.id, {
      direction,
      content: content || (mediaType ? `[${mediaType}]` : null),
      mediaType,
      waMessageId,
      timestamp,
      isGroup,
    });

    if (inserted) {
      const lastMessageText = content || `[${mediaType || "media"}]`;
      await updateConversationAfterMessage(this.db, conversation.id, lastMessageText, timestamp, direction === "inbound");
      await updateContactLastMessage(this.db, contact.id, timestamp);
    }
  }

  private extractMessageContent(msg: any): string | null {
    const m = msg.message;
    if (!m) return null;

    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
    if (m.documentMessage?.fileName) return `[Document: ${m.documentMessage.fileName}]`;

    return null;
  }
}
