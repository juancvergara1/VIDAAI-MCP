/**
 * Cloud API sync engine — pulls encrypted messages from relay, decrypts, writes to user's Neon.
 */

import { eq } from "drizzle-orm";
import type { UserDb } from "../db/index.js";
import { syncState } from "../db/schema.js";
import { sealDecrypt } from "../crypto.js";
import type { RelayClient } from "../relay-client.js";
import {
  upsertContact,
  upsertConversation,
  insertMessage,
  updateConversationAfterMessage,
  updateContactLastMessage,
} from "./sync-common.js";

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

      // Get or create contact + conversation
      const contact = await upsertContact(db, phone, contactName, contactName);
      const conversation = await upsertConversation(db, contact.id);

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
      const inserted = await insertMessage(db, conversation.id, {
        direction: msg.direction as "inbound" | "outbound",
        content: data.text || audioTranscription || null,
        mediaType: msg.mediaType,
        mediaData,
        audioTranscription,
        waMessageId: msg.waMessageId,
        timestamp: new Date(data.timestamp),
      });

      if (!inserted) {
        // Duplicate — still ack it
        ackIds.push(msg.id);
        continue;
      }

      // Update conversation + contact metadata
      const lastMessageText = data.text || `[${msg.mediaType || "media"}]`;
      await updateConversationAfterMessage(db, conversation.id, lastMessageText, new Date(data.timestamp), msg.direction === "inbound");
      await updateContactLastMessage(db, contact.id, new Date(data.timestamp));

      ackIds.push(msg.id);
      synced++;
    } catch (err: any) {
      console.error(`[Sync] Error processing message ${msg.id}:`, err.message);
    }
  }

  // Update sync state BEFORE acking
  if (ackIds.length > 0) {
    const now = new Date();
    const existing = await db.select().from(syncState).limit(1);
    if (existing.length > 0) {
      await db.update(syncState).set({ lastSyncAt: now }).where(eq(syncState.id, "default"));
    } else {
      await db.insert(syncState).values({ id: "default", lastSyncAt: now });
    }

    await relay.ackMessages(ackIds);
  }

  return synced;
}
