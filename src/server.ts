/**
 * WhatsApp MCP Server — core implementation.
 *
 * Supports two providers:
 * - Cloud API (default): VIDA AI relay with E2E encryption
 * - Baileys: Local WebSocket, personal WhatsApp
 *
 * Provider selected via VIDA_PROVIDER env var ("cloud" | "baileys").
 * All messages stored in user's own Neon database.
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
import { createProvider, type IWhatsAppProvider, type ProviderType } from "./providers/index.js";

export async function startServer() {
  // ── Environment ──

  const PROVIDER = (process.env.VIDA_PROVIDER || "cloud") as ProviderType;
  const NEON_URL = process.env.NEON_DATABASE_URL;

  if (!NEON_URL) {
    console.error("Missing NEON_DATABASE_URL. Add your Neon connection string.");
    process.exit(1);
  }

  // Cloud API requires API key + private key
  if (PROVIDER === "cloud") {
    if (!process.env.VIDA_API_KEY) {
      console.error("Missing VIDA_API_KEY. Get one at vidaai.co/mcp");
      process.exit(1);
    }
  }

  // Baileys requires auth directory
  if (PROVIDER === "baileys") {
    if (!process.env.VIDA_BAILEYS_AUTH) {
      console.error("Missing VIDA_BAILEYS_AUTH. Run 'npx @vidaai/whatsapp-mcp setup' to configure.");
      process.exit(1);
    }
  }

  const db = createDb(NEON_URL);

  // ── Provider ──

  let provider: IWhatsAppProvider;
  try {
    provider = await createProvider({
      provider: PROVIDER,
      db,
      apiKey: process.env.VIDA_API_KEY,
      keyPath: process.env.VIDA_KEY_PATH,
      baileysAuthDir: process.env.VIDA_BAILEYS_AUTH,
    });
    await provider.init();
    console.error(`[MCP] Provider "${PROVIDER}" initialized.`);
  } catch (err: any) {
    console.error(`[MCP] Failed to initialize provider "${PROVIDER}": ${err.message}`);
    if (PROVIDER === "cloud") {
      console.error("Run 'npx @vidaai/whatsapp-mcp setup' to generate your keypair.");
    } else {
      console.error("Run 'npx @vidaai/whatsapp-mcp setup' to reconnect WhatsApp.");
    }
    process.exit(1);
  }

  // Cleanup on exit
  process.on("SIGINT", async () => { await provider.destroy(); process.exit(0); });
  process.on("SIGTERM", async () => { await provider.destroy(); process.exit(0); });

  // ── MCP Server ──

  const server = new McpServer({
    name: "whatsapp",
    version: "0.3.0",
  });

  // Helper: sync with error swallowing (used by read tools)
  const doSync = () => provider.syncMessages(db).catch(() => 0);

  // ── Tools ──

  server.registerTool("whatsapp_sync", {
    description: "Sync new WhatsApp messages from relay. Call this before reading messages to get the latest.",
    inputSchema: {},
  }, async () => {
    const count = await provider.syncMessages(db);
    return { content: [{ type: "text" as const, text: count > 0 ? `Synced ${count} new messages.` : "Already up to date." }] };
  });

  server.registerTool("whatsapp_list_conversations", {
    description: "List recent WhatsApp conversations with contact name, last message, and unread count.",
    inputSchema: {
      limit: z.number().optional().describe("Max conversations to return (default 20)"),
    },
  }, async ({ limit }) => {
    await doSync();

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
    await doSync();

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
    await doSync();

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

    const result = await provider.sendMessage(phone, text);

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
    await doSync();

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

  // ── Prompts ──

  server.registerPrompt("daily-digest", {
    title: "Daily Digest",
    description: "Get a summary of today's WhatsApp messages grouped by contact, with key topics and action items.",
  }, async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Sync my WhatsApp messages, then give me a daily digest of today's conversations.

For each contact who messaged today:
- Contact name and number of messages
- Key topics discussed
- Any action items or follow-ups needed
- Urgency level (high/medium/low)

End with a "Pending actions" section listing anything I need to respond to or follow up on. Be concise and actionable.`,
      },
    }],
  }));

  server.registerPrompt("weekly-summary", {
    title: "Weekly Summary",
    description: "Get a weekly summary with most active contacts, key topics, and pending items.",
  }, async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Sync my WhatsApp messages, then give me a weekly summary of conversations from the last 7 days (since ${oneWeekAgo}).

Include:
1. **Most active contacts** — ranked by message count
2. **Key topics this week** — main themes across conversations
3. **Unresolved items** — conversations that need follow-up
4. **Quick stats** — total messages received, sent, unique contacts

Keep it brief and focused on what needs my attention.`,
        },
      }],
    };
  });

  server.registerPrompt("pending-followups", {
    title: "Pending Follow-ups",
    description: "List conversations where you need to respond or follow up.",
  }, async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Sync my WhatsApp messages, then analyze my conversations to find pending follow-ups.

Look for:
1. **Conversations where I haven't replied** — someone sent me a message and I haven't responded
2. **Conversations where I'm waiting** — I asked something and haven't gotten an answer
3. **Stale conversations** — important threads that went quiet in the last few days

For each, show: contact name, last message preview, how long ago, and suggested action. Sort by urgency.`,
      },
    }],
  }));

  server.registerPrompt("unread-brief", {
    title: "Unread Brief",
    description: "Quick sync and brief of all unread messages with suggested actions.",
  }, async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Sync my WhatsApp messages, then give me a quick brief of all unread messages.

For each unread conversation:
- Who sent it and when
- One-line summary of what they said
- Suggested quick reply (if applicable)

Keep it short — I want to scan this in 30 seconds.`,
      },
    }],
  }));

  server.registerPrompt("generate-todo-report", {
    title: "Generate To-Do Report",
    description: "Analyze all conversations, extract action items, and generate a markdown to-do document with due dates and responsible parties.",
    argsSchema: {
      outputPath: z.string().optional().describe("Folder path to save the report (default: ./VIDA AI - WhatsApp To Dos)"),
      since: z.string().optional().describe("Only analyze messages since this date (ISO format, default: last 7 days)"),
    },
  }, async ({ outputPath, since }) => {
    const defaultSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sinceDate = since || defaultSince;
    const folder = outputPath || "./VIDA AI - WhatsApp To Dos";
    const today = new Date().toISOString().split("T")[0];

    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Sync my WhatsApp messages, then analyze ALL conversations since ${sinceDate} to extract every action item, commitment, deadline, and follow-up.

Then generate a markdown report and save it to: ${folder}/to-dos-${today}.md

The report should have this structure:

# WhatsApp To-Dos — ${today}

## High Priority
| Action Item | Responsible | Due Date | Source Conversation | Status |
|------------|-------------|----------|-------------------|--------|
(items that have explicit deadlines or urgency)

## Follow-ups Needed
| Action Item | Responsible | Context | Last Activity |
|------------|-------------|---------|--------------|
(conversations where someone owes me a response or I owe them one)

## Commitments Made
| What I Promised | To Whom | When | Context |
|----------------|---------|------|---------|
(things I said I would do)

## Pending Decisions
| Decision | Parties Involved | Context |
|----------|-----------------|---------|
(things that need a decision from me or someone else)

## Notes
(any other relevant context from conversations)

---
*Generated from WhatsApp conversations (${sinceDate} to ${today}) by VIDA AI WhatsApp MCP*

Rules:
- Extract REAL action items from message content — don't make things up
- "Responsible" = who needs to take action (me or the contact name)
- If there's no explicit due date, leave it blank or write "ASAP" if urgent
- Include the contact name as "Source Conversation" so I know where it came from
- Also create the existing action items from my database (whatsapp_list_action_items) in the report
- Create the folder if it doesn't exist
- Be thorough — scan every conversation`,
        },
      }],
    };
  });

  // ── Start ──

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WhatsApp MCP Server running on stdio");
}
