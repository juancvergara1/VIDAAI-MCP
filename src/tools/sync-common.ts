/**
 * Common DB write operations for syncing WhatsApp messages.
 * Used by both Cloud API (relay) and Baileys providers.
 */

import { eq, sql } from "drizzle-orm";
import type { UserDb } from "../db/index.js";
import { contacts, conversations, messages } from "../db/schema.js";

export interface MessageInput {
  direction: "inbound" | "outbound";
  content: string | null;
  mediaType?: string | null;
  mediaData?: string | null;
  mediaFilename?: string | null;
  audioTranscription?: string | null;
  waMessageId?: string | null;
  timestamp: Date;
  isGroup?: boolean;
}

/**
 * Get or create a contact by phone number.
 * Updates name if previously unknown.
 */
export async function upsertContact(
  db: UserDb,
  phone: string,
  name?: string | null,
  profileName?: string | null,
) {
  let contact = await db.query.contacts.findFirst({
    where: eq(contacts.phone, phone),
  });

  if (!contact) {
    const [newContact] = await db.insert(contacts).values({
      phone,
      name: name || null,
      profileName: profileName || null,
    }).returning();
    contact = newContact;
  } else if (name && !contact.name) {
    await db.update(contacts).set({ name }).where(eq(contacts.id, contact.id));
  }

  return contact;
}

/**
 * Get or create a conversation for a contact.
 */
export async function upsertConversation(db: UserDb, contactId: string) {
  let conversation = await db.query.conversations.findFirst({
    where: eq(conversations.contactId, contactId),
  });

  if (!conversation) {
    const [newConv] = await db.insert(conversations).values({
      contactId,
    }).returning();
    conversation = newConv;
  }

  return conversation;
}

/**
 * Insert a message with deduplication by waMessageId.
 * Returns the message or null if duplicate.
 */
export async function insertMessage(
  db: UserDb,
  conversationId: string,
  input: MessageInput,
) {
  try {
    const [msg] = await db.insert(messages).values({
      conversationId,
      direction: input.direction,
      content: input.content,
      mediaType: input.mediaType || null,
      mediaData: input.mediaData || null,
      mediaFilename: input.mediaFilename || null,
      audioTranscription: input.audioTranscription || null,
      waMessageId: input.waMessageId || null,
      timestamp: input.timestamp,
      isRead: input.direction === "outbound" ? "true" : "false",
    }).returning();
    return msg;
  } catch (err: any) {
    // Unique constraint on waMessageId — already synced
    if (err.message?.includes("unique") || err.code === "23505") {
      return null;
    }
    throw err;
  }
}

/**
 * Update conversation metadata after a new message.
 */
export async function updateConversationAfterMessage(
  db: UserDb,
  conversationId: string,
  lastMessage: string,
  timestamp: Date,
  isInbound: boolean,
) {
  await db.update(conversations).set({
    lastMessage,
    lastMessageAt: timestamp,
    ...(isInbound ? { unreadCount: sql`coalesce(${conversations.unreadCount}, 0) + 1` } : {}),
  }).where(eq(conversations.id, conversationId));
}

/**
 * Update contact's last message timestamp.
 */
export async function updateContactLastMessage(
  db: UserDb,
  contactId: string,
  timestamp: Date,
) {
  await db.update(contacts).set({
    lastMessageAt: timestamp,
  }).where(eq(contacts.id, contactId));
}
