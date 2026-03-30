/**
 * Baileys Provider — Local WebSocket to WhatsApp via @whiskeysockets/baileys.
 * Personal WhatsApp, QR code auth, real-time message push, groups support.
 *
 * STUB: Full implementation in Phase B.
 */

import type { IWhatsAppProvider, SendResult } from "./types.js";
import type { UserDb } from "../db/index.js";

export interface BaileysConfig {
  authDir: string;
}

export class BaileysProvider implements IWhatsAppProvider {
  private db: UserDb;
  private authDir: string;

  constructor(config: BaileysConfig, db: UserDb) {
    this.db = db;
    this.authDir = config.authDir;
  }

  async init(): Promise<void> {
    throw new Error("Baileys provider not yet implemented. Coming in v0.3.0.");
  }

  async syncMessages(): Promise<number> {
    return 0; // Baileys is push-based
  }

  async sendMessage(_to: string, _text: string): Promise<SendResult> {
    return { success: false, error: "Baileys provider not yet implemented." };
  }

  async destroy(): Promise<void> {
    // No-op stub
  }
}
