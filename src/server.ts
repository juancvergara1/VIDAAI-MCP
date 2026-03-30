/**
 * WhatsApp MCP Server — core implementation.
 *
 * Connects to VIDA AI relay for encrypted message sync.
 * All messages stored in user's own Neon database.
 * Private key never leaves this machine.
 *
 * IMPORTANT: Never use console.log() — it corrupts stdio JSON-RPC.
 * Use console.error() for all logging.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDb } from "./db/index.js";
import { contacts, conversations, messages, actionItems } from "./db/schema.js";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { RelayClient } from "./relay-client.js";
import { loadPrivateKey } from "./crypto.js";
import { syncMessages } from "./tools/sync.js";

export async function startServer() {
  // ── Environment ──

  const VIDA_API_KEY = process.env.VIDA_API_KEY;
  const NEON_URL = process.env.NEON_DATABASE_URL;
  const KEY_PATH = process.env.VIDA_KEY_PATH;

  if (!VIDA_API_KEY) {
    console.error("Missing VIDA_API_KEY. Get one at vidaai.co/mcp");
    process.exit(1);
  }
  if (!NEON_URL) {
    console.error("Missing NEON_DATABASE_URL. Add your Neon connection string.");
    process.exit(1);
  }

  const db = createDb(NEON_URL);
  const relay = new RelayClient(VIDA_API_KEY);

  let publicKey: Uint8Array;
  let secretKey: Uint8Array;
  try {
    const keys = loadPrivateKey(KEY_PATH);
    publicKey = keys.publicKey;
    secretKey = keys.secretKey;
  } catch (err: any) {
    console.error(`Failed to load private key: ${err.message}`);
    console.error(`Run 'npx @vidaai/whatsapp-mcp setup' to generate your keypair.`);
    process.exit(1);
  }

  // ── MCP Server ──

  const server = new McpServer({
    name: "whatsapp",
    version: "0.1.0",
  });

  // ── Tools ──

  server.registerTool("whatsapp_sync", {
    description: "Sync new WhatsApp messages from relay. Call this before reading messages to get the latest.",
    inputSchema: {},
  }, async () => {
    const count = await syncMessages(relay, db, publicKey, secretKey);
    return { content: [{ type: "text" as const, text: count > 0 ? `Synced ${count} new messages.` : "Already up to date." }] };
  });

  server.registerTool("whatsapp_list_conversations", {
    description: "List recent WhatsApp conversations with contact name, last message, and unread count.",
    inputSchema: {
      limit: z.number().optional().describe("Max conversations to return (default 20)"),
    },
  }, async ({ limit }) => {
    await syncMessages(relay, db, publicKey, secretKey).catch(() => {});

    const convs = await db.query.conversations.findMany({
      limit: limit || 20,
      orderBy: [desc(conversations.lastMessageAt)],
      with: { contact: true },
    });

    const result = convs.map(c => ({
      conversationId: c.id,
      contact: c.contact?.name || c.contact?.phone || "Unknown",
      phone: c.contact?.phone,
      lastMessage: c.lastMessage,
      lastMessageAt: c.lastMessageAt?.toISOString(),
      unreadCount: c.unreadCount || 0,
    }));

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("whatsapp_read_messages", {
    description: "Read messages from a specific contact or conversation.",
    inputSchema: {
      contact: z.string().optional().describe("Contact name or phone number to search for"),
      conversationId: z.string().optional().describe("Conversation UUID (from list_conversations)"),
      limit: z.number().optional().describe("Max messages to return (default 30)"),
    },
  }, async ({ contact, conversationId, limit }) => {
    await syncMessages(relay, db, publicKey, secretKey).catch(() => {});

    let convId = conversationId;

    if (!convId && contact) {
      const searchTerm = `%${contact.toLowerCase()}%`;
      const matchedContact = await db.query.contacts.findFirst({
        where: (c, { or }) => or(
          sql`lower(${c.name}) like ${searchTerm}`,
          sql`${c.phone} like ${searchTerm}`,
        ),
      });
      if (matchedContact) {
        const conv = await db.query.conversations.findFirst({
          where: eq(conversations.contactId, matchedContact.id),
        });
        convId = conv?.id;
      }
    }

    if (!convId) {
      return { content: [{ type: "text" as const, text: `No conversation found${contact ? ` for "${contact}"` : ""}. Use whatsapp_list_conversations to see available conversations.` }] };
    }

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(desc(messages.timestamp))
      .limit(limit || 30);

    await db.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, convId));

    const result = msgs.reverse().map(m => ({
      direction: m.direction,
      content: m.content || (m.audioTranscription ? `[Audio] ${m.audioTranscription}` : `[${m.mediaType || "media"}]`),
      timestamp: m.timestamp.toISOString(),
      mediaType: m.mediaType,
    }));

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("whatsapp_search", {
    description: "Search messages by keyword across all conversations.",
    inputSchema: {
      query: z.string().describe("Search keyword"),
      from: z.string().optional().describe("Filter by contact name"),
      since: z.string().optional().describe("ISO date — messages after this date"),
      until: z.string().optional().describe("ISO date — messages before this date"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
  }, async ({ query, from, since, until, limit: maxResults }) => {
    await syncMessages(relay, db, publicKey, secretKey).catch(() => {});

    const conditions = [sql`lower(${messages.content}) like ${"%" + query.toLowerCase() + "%"}`];
    if (since) conditions.push(gte(messages.timestamp, new Date(since)));
    if (until) conditions.push(lte(messages.timestamp, new Date(until)));

    let results = await db
      .select({
        id: messages.id,
        content: messages.content,
        direction: messages.direction,
        timestamp: messages.timestamp,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.timestamp))
      .limit(maxResults || 20);

    const enriched = await Promise.all(results.map(async (m) => {
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.id, m.conversationId),
        with: { contact: true },
      });
      const contactName = conv?.contact?.name || conv?.contact?.phone || "Unknown";
      if (from && !contactName.toLowerCase().includes(from.toLowerCase())) return null;
      return { ...m, contact: contactName, timestamp: m.timestamp.toISOString() };
    }));

    const filtered = enriched.filter(Boolean);

    return { content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] };
  });

  server.registerTool("whatsapp_send_message", {
    description: "Send a WhatsApp message to a contact. The message goes through the VIDA AI relay.",
    inputSchema: {
      to: z.string().describe("Contact name or phone number"),
      text: z.string().describe("Message text to send"),
    },
    annotations: { destructiveHint: true },
  }, async ({ to, text }) => {
    let phone = to.replace(/\D/g, "");

    if (phone.length < 10) {
      const searchTerm = `%${to.toLowerCase()}%`;
      const matched = await db.query.contacts.findFirst({
        where: sql`lower(${contacts.name}) like ${searchTerm}`,
      });
      if (matched) {
        phone = matched.phone;
      } else {
        return { content: [{ type: "text" as const, text: `Contact "${to}" not found. Use a phone number instead.` }] };
      }
    }

    const result = await relay.sendMessage(phone, text);

    if (result.success) {
      return { content: [{ type: "text" as const, text: `Message sent to ${phone}.` }] };
    } else {
      return { content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }] };
    }
  });

  server.registerTool("whatsapp_unread_summary", {
    description: "Get a summary of unread messages across all conversations.",
    inputSchema: {},
  }, async () => {
    await syncMessages(relay, db, publicKey, secretKey).catch(() => {});

    const unreadConvs = await db.query.conversations.findMany({
      where: sql`${conversations.unreadCount} > 0`,
      with: { contact: true },
      orderBy: [desc(conversations.lastMessageAt)],
    });

    if (unreadConvs.length === 0) {
      return { content: [{ type: "text" as const, text: "No unread messages." }] };
    }

    const summary = unreadConvs.map(c => ({
      contact: c.contact?.name || c.contact?.phone || "Unknown",
      unread: c.unreadCount,
      lastMessage: c.lastMessage,
      lastAt: c.lastMessageAt?.toISOString(),
    }));

    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  });

  server.registerTool("whatsapp_create_action_item", {
    description: "Create an action item / task from a WhatsApp message for follow-up.",
    inputSchema: {
      title: z.string().describe("Action item title"),
      description: z.string().optional().describe("Additional context"),
      dueDate: z.string().optional().describe("Due date (ISO format)"),
      messageId: z.string().optional().describe("Related message UUID"),
    },
  }, async ({ title, description, dueDate, messageId }) => {
    const [item] = await db.insert(actionItems).values({
      title,
      description: description || null,
      dueDate: dueDate ? new Date(dueDate) : null,
      messageId: messageId || null,
    }).returning();

    return { content: [{ type: "text" as const, text: `Action item created: "${title}" (ID: ${item.id})` }] };
  });

  server.registerTool("whatsapp_list_action_items", {
    description: "List action items / tasks, optionally filtered by status.",
    inputSchema: {
      status: z.enum(["pending", "done"]).optional().describe("Filter by status"),
    },
  }, async ({ status }) => {
    const conditions = status ? [eq(actionItems.status, status)] : [];

    const items = await db
      .select()
      .from(actionItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(actionItems.createdAt))
      .limit(50);

    const result = items.map(i => ({
      id: i.id,
      title: i.title,
      description: i.description,
      status: i.status,
      dueDate: i.dueDate?.toISOString(),
      createdAt: i.createdAt.toISOString(),
    }));

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("whatsapp_complete_action_item", {
    description: "Mark an action item as completed.",
    inputSchema: {
      actionItemId: z.string().describe("Action item UUID"),
    },
  }, async ({ actionItemId }) => {
    await db.update(actionItems).set({ status: "done" }).where(eq(actionItems.id, actionItemId));
    return { content: [{ type: "text" as const, text: `Action item ${actionItemId} marked as done.` }] };
  });

  // ── Start ──

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WhatsApp MCP Server running on stdio");
}
