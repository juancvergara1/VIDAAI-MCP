/**
 * Baileys Provider — Local WebSocket to WhatsApp via @whiskeysockets/baileys.
 * Personal WhatsApp, QR code auth, real-time message push, groups support.
 *
 * Messages arrive in real-time via WebSocket events and are written to DB immediately.
 * syncMessages() is a no-op since messages are push-based.
 *
 * CRITICAL: All logging goes to stderr. Never use console.log() — corrupts MCP stdio.
 */

import type { IWhatsAppProvider, SendResult } from "./types.js";
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

  // Baileys modules (loaded once in init, reused in reconnect)
  private makeWASocket: any;
  private useMultiFileAuthState: any;
  private DisconnectReason: any;
  private logger: any;

  constructor(config: BaileysConfig, db: UserDb) {
    this.db = db;
    // Resolve ~ to home directory
    this.authDir = config.authDir.startsWith("~")
      ? resolve(homedir(), config.authDir.slice(2))
      : resolve(config.authDir);
  }

  async init(): Promise<void> {
    // Dynamic imports to avoid loading Baileys when not needed
    const baileys = await import("@whiskeysockets/baileys");
    this.makeWASocket = baileys.default;
    this.useMultiFileAuthState = baileys.useMultiFileAuthState;
    this.DisconnectReason = baileys.DisconnectReason;
    const pino = (await import("pino")).default;

    // CRITICAL: silent logger — Baileys/pino must NOT write to stdout
    this.logger = pino({ level: "silent" });

    // Wait for first connection
    await new Promise<void>((resolveInit, reject) => {
      let settled = false;

      // onConnectionUpdate is called by connect() on every socket (including reconnects)
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
            try {
              await this.connect();
            } catch (reconnErr: any) {
              console.error("[Baileys] Reconnect failed:", reconnErr.message);
            }
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

      // Timeout after 30s
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
   * Used for initial connect and reconnects.
   */
  private async connect(): Promise<void> {
    const { state, saveCreds } = await this.useMultiFileAuthState(this.authDir);

    this.sock = this.makeWASocket({
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      browser: ["VIDA AI MCP", "Chrome", "1.0.0"],
    });

    this.sock.ev.on("creds.update", saveCreds);

    // Register connection handler (persists across reconnects via closure)
    if (this.onConnectionUpdate) {
      this.sock.ev.on("connection.update", this.onConnectionUpdate);
    }

    // Handle incoming messages — write to DB in real-time
    this.sock.ev.on("messages.upsert", async (event: any) => {
      const { messages: msgs, type } = event;
      if (type !== "notify") return;

      for (const msg of msgs) {
        try {
          await this.processMessage(msg);
        } catch (err: any) {
          console.error("[Baileys] Error processing message:", err.message);
        }
      }
    });
  }

  async syncMessages(): Promise<number> {
    // Baileys is push-based — messages arrive via WebSocket events
    return 0;
  }

  async sendMessage(to: string, text: string): Promise<SendResult> {
    if (!this.sock) {
      return { success: false, error: "Not connected to WhatsApp." };
    }

    try {
      // Resolve phone to JID
      const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;

      const sent = await this.sock.sendMessage(jid, { text });
      const waMessageId = sent?.key?.id || null;

      // Track this ID so processMessage() skips the echo from Baileys
      if (waMessageId) {
        this.recentSentIds.add(waMessageId);
        // Clean up after 30s to avoid memory leak
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

  async destroy(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Best-effort cleanup
      }
      this.sock = null;
    }
  }

  /**
   * Process a single incoming Baileys message and write to DB.
   */
  private async processMessage(msg: any): Promise<void> {
    // Skip status broadcasts and protocol messages
    if (!msg.message) return;
    if (msg.key?.remoteJid === "status@broadcast") return;

    // Skip messages we just sent via sendMessage() (already written to DB)
    const msgId = msg.key?.id;
    if (msgId && this.recentSentIds.has(msgId)) {
      this.recentSentIds.delete(msgId);
      return;
    }

    const remoteJid = msg.key?.remoteJid || "";
    const isGroup = remoteJid.endsWith("@g.us");
    const isFromMe = msg.key?.fromMe || false;

    // Extract phone/group ID
    const phone = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
    if (!phone) return;

    // Extract message content
    const content = this.extractMessageContent(msg);
    if (!content && !msg.message?.imageMessage && !msg.message?.audioMessage && !msg.message?.documentMessage && !msg.message?.videoMessage) {
      return; // Skip empty/unsupported messages
    }

    // Determine contact name
    let contactName: string | null = null;
    if (isGroup) {
      // For groups, use group subject as contact name
      try {
        const groupMeta = await this.sock.groupMetadata(remoteJid);
        contactName = groupMeta?.subject || null;
      } catch {
        contactName = null;
      }
    } else {
      contactName = msg.pushName || null;
    }

    // Determine media type
    let mediaType: string | null = null;
    if (msg.message?.imageMessage) mediaType = "image";
    else if (msg.message?.audioMessage) mediaType = "audio";
    else if (msg.message?.videoMessage) mediaType = "video";
    else if (msg.message?.documentMessage) mediaType = "document";

    const direction = isFromMe ? "outbound" : "inbound";
    const timestamp = new Date((msg.messageTimestamp as number) * 1000);
    const waMessageId = msg.key?.id || null;

    // Write to DB
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

  /**
   * Extract text content from a Baileys message object.
   */
  private extractMessageContent(msg: any): string | null {
    const m = msg.message;
    if (!m) return null;

    // Text message
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

    // Media with caption
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;

    // Document filename as fallback
    if (m.documentMessage?.fileName) return `[Document: ${m.documentMessage.fileName}]`;

    return null;
  }
}
