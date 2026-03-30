/**
 * Database schema for the user's Neon DB.
 * These tables live in the USER's database, not ours.
 * Created during MCP setup via migrations.
 */

import { pgTable, text, varchar, timestamp, integer } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const contacts = pgTable("mcp_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  profileName: text("profile_name"),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const conversations = pgTable("mcp_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at"),
  unreadCount: integer("unread_count").default(0),
  isGroup: text("is_group").default("false"), // "true" for group conversations (Baileys)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messages = pgTable("mcp_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(), // 'inbound' | 'outbound'
  content: text("content"),
  mediaType: text("media_type"), // 'image' | 'audio' | 'video' | 'document' | null
  mediaData: text("media_data"), // base64 image/pdf data
  mediaFilename: text("media_filename"),
  audioTranscription: text("audio_transcription"), // Whisper transcription
  waMessageId: text("wa_message_id").unique(),
  timestamp: timestamp("timestamp").notNull(),
  isRead: text("is_read").default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const actionItems = pgTable("mcp_action_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageId: varchar("message_id").references(() => messages.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").default("pending"), // 'pending' | 'done'
  dueDate: timestamp("due_date"),
  externalId: text("external_id"), // ClickUp/Linear task ID (v2)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const syncState = pgTable("mcp_sync_state", {
  id: text("id").primaryKey().default("default"),
  lastSyncAt: timestamp("last_sync_at"),
  lastAckId: text("last_ack_id"),
});

// Relations for query builder
export const contactsRelations = relations(contacts, ({ many }) => ({
  conversations: many(conversations),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));

export const actionItemsRelations = relations(actionItems, ({ one }) => ({
  message: one(messages, { fields: [actionItems.messageId], references: [messages.id] }),
}));
