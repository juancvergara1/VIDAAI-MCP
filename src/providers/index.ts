/**
 * Provider factory — creates the appropriate WhatsApp provider based on config.
 */

import type { IWhatsAppProvider } from "./types.js";
import type { UserDb } from "../db/index.js";
import { CloudApiProvider } from "./cloud-api.js";

export type ProviderType = "cloud" | "baileys";

export interface ProviderConfig {
  provider: ProviderType;
  db: UserDb;
  // Cloud API
  apiKey?: string;
  keyPath?: string;
  // Baileys
  baileysAuthDir?: string;
}

export async function createProvider(config: ProviderConfig): Promise<IWhatsAppProvider> {
  if (config.provider === "baileys") {
    // Dynamic import to avoid loading Baileys when using Cloud API
    const { BaileysProvider } = await import("./baileys.js");
    return new BaileysProvider({ authDir: config.baileysAuthDir! }, config.db);
  }

  return new CloudApiProvider(
    { apiKey: config.apiKey!, keyPath: config.keyPath },
    config.db,
  );
}

export type { IWhatsAppProvider } from "./types.js";
