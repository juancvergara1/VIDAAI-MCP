/**
 * Cloud API Provider — uses VIDA AI relay for encrypted message sync.
 * Wraps the existing RelayClient + sealed box crypto.
 */

import type { IWhatsAppProvider, SendResult, MediaMessage } from "./types.js";
import type { UserDb } from "../db/index.js";
import { RelayClient } from "../relay-client.js";
import { loadPrivateKey } from "../crypto.js";
import { syncMessages } from "../tools/sync.js";

export interface CloudApiConfig {
  apiKey: string;
  keyPath?: string;
}

export class CloudApiProvider implements IWhatsAppProvider {
  private relay: RelayClient;
  private publicKey!: Uint8Array;
  private secretKey!: Uint8Array;
  private db: UserDb;
  private keyPath?: string;

  constructor(config: CloudApiConfig, db: UserDb) {
    this.relay = new RelayClient(config.apiKey);
    this.db = db;
    this.keyPath = config.keyPath;
  }

  async init(): Promise<void> {
    const keys = loadPrivateKey(this.keyPath);
    this.publicKey = keys.publicKey;
    this.secretKey = keys.secretKey;
  }

  async syncMessages(): Promise<number> {
    return syncMessages(this.relay, this.db, this.publicKey, this.secretKey);
  }

  async sendMessage(to: string, text: string): Promise<SendResult> {
    return this.relay.sendMessage(to, text);
  }

  async sendMedia(_to: string, _media: MediaMessage): Promise<SendResult> {
    return { success: false, error: "Media sending is not supported with Cloud API provider. Use Baileys provider instead." };
  }

  async destroy(): Promise<void> {
    // No-op for Cloud API
  }
}
