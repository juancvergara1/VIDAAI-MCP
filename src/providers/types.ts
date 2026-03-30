/**
 * WhatsApp Provider Interface
 *
 * Both Cloud API (relay) and Baileys (local WebSocket) implement this.
 * The MCP server tools only interact with the database — providers
 * handle the transport layer.
 */

import type { UserDb } from "../db/index.js";

export interface SendResult {
  success: boolean;
  waMessageId?: string;
  error?: string;
}

export interface IWhatsAppProvider {
  /** Initialize the provider (validate keys, connect WebSocket, etc.) */
  init(): Promise<void>;

  /** Sync new messages into the database. Returns count of new messages. */
  syncMessages(db: UserDb): Promise<number>;

  /** Send a text message. Returns success/error. */
  sendMessage(to: string, text: string): Promise<SendResult>;

  /** Clean shutdown (close WebSocket, etc.) */
  destroy(): Promise<void>;
}
