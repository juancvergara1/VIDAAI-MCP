/**
 * Sync engine — pulls encrypted messages from relay, decrypts, writes to user's Neon.
 */

import { eq, sql } from "drizzle-orm";
import type { UserDb } from "../db/index.js";
import { contacts, conversations, messages, syncState } from "../db/schema.js";
import { sealDecrypt } from "../crypto.js";
import type { RelayClient } from "../relay-client.js";

interface DecryptedMessage {
  type: string;
  from: string;
  to?: string;
  text: string;
  timestamp: string;
  contacts?: Array<{ name?: string }>;
}

export async function syncMessages(
  relay: RelayClient,
  db: UserDb,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): Promise<number> {
  // Get last sync timestamp
  const stateRows = await db.select().from(syncState).limit(1);
  const lastSync = stateRows[0]?.lastSyncAt?.toISOString() || undefined;

  // Pull encrypted messages from relay
  const { messages: encryptedMsgs } = await relay.pullMessages(lastSync, 200);

  if (encryptedMsgs.length === 0) return 0;

  let synced = 0;
  const ackIds: string[] = [];

  for (const msg of encryptedMsgs) {
    try {
      // Decrypt message payload
      const plaintext = sealDecrypt(msg.encryptedBlob, publicKey, secretKey);
      if (!plaintext) {
        console.error(`[Sync] Failed to decrypt message ${msg.id} — wrong key?`);
        continue;
      }

      const data: DecryptedMessage = JSON.parse(plaintext);

      // Determine phone (sender for inbound, recipient for outbound)
      const phone = msg.senderPhone;
      const contactName = data.contacts?.[0]?.name || null;

      // Get or create contact
      let contact = await db.query.contacts.findFirst({
        where: eq(contacts.phone, phone),
      });

      if (!contact) {
        const [newContact] = await db.insert(contacts).values({
          phone,
          name: contactName,
          profileName: contactName,
        }).returning();
        contact = newContact;
      } else if (contactName && !contact.name) {
        // Update name if we have it now
        await db.update(contacts).set({ name: contactName }).where(eq(contacts.id, contact.id));
      }

      // Get or create conversation
      let conversation = await db.query.conversations.findFirst({
        where: eq(conversations.contactId, contact.id),
      });

      if (!conversation) {
        const [newConv] = await db.insert(conversations).values({
          contactId: contact.id,
        }).returning();
        conversation = newConv;
      }

      // Decrypt media if present
      let mediaData: string | null = null;
      if (msg.mediaEncryptedBlob) {
        mediaData = sealDecrypt(msg.mediaEncryptedBlob, publicKey, secretKey);
      }

      // Decrypt audio transcription if present
      let audioTranscription: string | null = null;
      if (msg.audioTranscriptionBlob) {
        audioTranscription = sealDecrypt(msg.audioTranscriptionBlob, publicKey, secretKey);
      }

      // Insert message (dedup by waMessageId)
      try {
        await db.insert(messages).values({
          conversationId: conversation.id,
          direction: msg.direction,
          content: data.text || audioTranscription || null,
          mediaType: msg.mediaType,
          mediaData,
          audioTranscription,
          waMessageId: msg.waMessageId,
          timestamp: new Date(data.timestamp),
          isRead: msg.direction === "outbound" ? "true" : "false",
        });
      } catch (insertErr: any) {
        // Unique constraint on waMessageId — already synced
        if (insertErr.message?.includes("unique") || insertErr.code === "23505") {
          ackIds.push(msg.id);
          continue;
        }
        throw insertErr;
      }

      // Update conversation metadata (atomic increment for unread count)
      await db.update(conversations).set({
        lastMessage: data.text || `[${msg.mediaType || "media"}]`,
        lastMessageAt: new Date(data.timestamp),
        ...(msg.direction === "inbound" ? { unreadCount: sql`coalesce(${conversations.unreadCount}, 0) + 1` } : {}),
      }).where(eq(conversations.id, conversation.id));

      // Update contact last message time
      await db.update(contacts).set({
        lastMessageAt: new Date(data.timestamp),
      }).where(eq(contacts.id, contact.id));

      ackIds.push(msg.id);
      synced++;
    } catch (err: any) {
      console.error(`[Sync] Error processing message ${msg.id}:`, err.message);
      // Continue with next message — don't ack this one
    }
  }

  // Update sync state BEFORE acking (if crash after ack but before state update, messages lost)
  if (ackIds.length > 0) {
    const now = new Date();
    const existing = await db.select().from(syncState).limit(1);
    if (existing.length > 0) {
      await db.update(syncState).set({ lastSyncAt: now }).where(eq(syncState.id, "default"));
    } else {
      await db.insert(syncState).values({ id: "default", lastSyncAt: now });
    }

    // Now safe to ack — if we crash here, relay re-delivers but dedup catches it
    await relay.ackMessages(ackIds);
  }

  return synced;
}
