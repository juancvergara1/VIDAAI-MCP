#!/usr/bin/env node

/**
 * WhatsApp MCP Setup CLI
 *
 * Interactive setup supporting two providers:
 * - Cloud API: WhatsApp Business, E2E encrypted relay ($25/mo)
 * - Baileys: Personal WhatsApp, QR code scan ($25/mo)
 *
 * Usage: npx @vidaai/whatsapp-mcp setup
 */

import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";

// Simple readline prompt
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

// ── Shared: DB setup ──

async function setupDatabase(neonUrl: string) {
  // Test connection
  log("  Testing database connection...");
  const testSql = neon(neonUrl);
  const testDb = drizzle(testSql);
  await testDb.execute(sql`SELECT 1`);
  log("  Database connected OK");

  // Create tables
  log("  Creating tables...");
  const migSql = neon(neonUrl);
  const migDb = drizzle(migSql);

  await migDb.execute(sql`
    CREATE TABLE IF NOT EXISTS mcp_contacts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      profile_name TEXT,
      last_message_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await migDb.execute(sql`
    CREATE TABLE IF NOT EXISTS mcp_conversations (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id VARCHAR NOT NULL REFERENCES mcp_contacts(id) ON DELETE CASCADE,
      last_message TEXT,
      last_message_at TIMESTAMP,
      unread_count INTEGER DEFAULT 0,
      is_group TEXT DEFAULT 'false',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  // Add is_group column if table already exists (upgrade path)
  await migDb.execute(sql`
    ALTER TABLE mcp_conversations ADD COLUMN IF NOT EXISTS is_group TEXT DEFAULT 'false'
  `).catch(() => {}); // Ignore if column already exists or DB doesn't support IF NOT EXISTS

  await migDb.execute(sql`
    CREATE TABLE IF NOT EXISTS mcp_messages (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id VARCHAR NOT NULL REFERENCES mcp_conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      content TEXT,
      media_type TEXT,
      media_data TEXT,
      media_filename TEXT,
      audio_transcription TEXT,
      wa_message_id TEXT UNIQUE,
      timestamp TIMESTAMP NOT NULL,
      is_read TEXT DEFAULT 'false',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await migDb.execute(sql`
    CREATE TABLE IF NOT EXISTS mcp_action_items (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id VARCHAR REFERENCES mcp_messages(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      due_date TIMESTAMP,
      external_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await migDb.execute(sql`
    CREATE TABLE IF NOT EXISTS mcp_sync_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      last_sync_at TIMESTAMP,
      last_ack_id TEXT
    )
  `);

  log("  Tables created OK");
}

// ── Shared: Write config to Claude Code ──

function writeConfigToClaude(whatsappServer: any): boolean {
  const mcpJsonPath = resolve(homedir(), ".claude", ".mcp.json");

  try {
    let mcpConfig: any = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      const existing = readFileSync(mcpJsonPath, "utf-8");
      mcpConfig = JSON.parse(existing);
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } else {
      mkdirSync(dirname(mcpJsonPath), { recursive: true });
    }

    mcpConfig.mcpServers.whatsapp = whatsappServer;
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
    log(`  Config written to ${mcpJsonPath}`);
    return true;
  } catch (err: any) {
    log(`  Could not auto-write config: ${err.message}`);
    return false;
  }
}

// ── Cloud API Setup ──

async function setupCloudApi() {
  // API Key
  let apiKey = process.env.VIDA_API_KEY || "";
  if (!apiKey) {
    apiKey = await ask("  API key (from vidaai.co/mcp): ");
  }
  if (!apiKey.startsWith("sk_")) {
    log("  Error: Invalid API key format. Should start with 'sk_'");
    process.exit(1);
  }

  // Validate against relay
  const { RelayClient } = await import("../relay-client.js");
  const relay = new RelayClient(apiKey);
  log("  Validating API key...");
  try {
    const status = await relay.getWhatsAppStatus();
    if (status.connected) {
      log(`  WhatsApp connected: ${status.displayPhone || "yes"}`);
      if (status.isCoexistence) {
        log("  Note: Coexistence mode — messages from your phone won't appear here.");
      }
    } else {
      log("  WhatsApp not yet connected. Connect at vidaai.co/mcp first.");
      process.exit(1);
    }
  } catch (err: any) {
    log(`  Error: ${err.message}`);
    process.exit(1);
  }

  // Neon DB
  let neonUrl = await askForNeonUrl();
  await setupDatabase(neonUrl);

  // Keypair
  const { generateKeyPair, loadPrivateKey } = await import("../crypto.js");
  const keyPath = resolve(homedir(), ".vida", "private.key");
  let publicKeyBase64: string;

  if (existsSync(keyPath)) {
    log(`  Existing keypair found at ${keyPath}`);
    const keys = loadPrivateKey(keyPath);
    publicKeyBase64 = Buffer.from(keys.publicKey).toString("base64");
  } else {
    log("  Generating encryption keypair...");
    const { publicKey, keyPath: savedPath } = generateKeyPair(keyPath);
    publicKeyBase64 = publicKey;
    log(`  Private key saved to ${savedPath}`);
    log("  IMPORTANT: Back up this key. If lost, your messages are unrecoverable.");
  }

  // Register public key
  log("  Registering public key and activating webhooks...");
  await relay.registerKey(publicKeyBase64);
  log("  Webhooks activated OK");

  // Write config
  const whatsappServer = {
    command: "npx",
    args: ["-y", "@vidaai/whatsapp-mcp"],
    env: {
      VIDA_API_KEY: apiKey,
      NEON_DATABASE_URL: neonUrl,
      VIDA_KEY_PATH: keyPath,
    },
  };

  const written = writeConfigToClaude(whatsappServer);
  printSuccess(written, whatsappServer);
}

// ── Baileys Setup ──

async function setupBaileys() {
  // API Key (required for all providers — validates registration + billing)
  let apiKey = process.env.VIDA_API_KEY || "";
  if (!apiKey) {
    apiKey = await ask("  API key (from vidaai.co/mcp): ");
  }
  if (!apiKey.startsWith("sk_")) {
    log("  Error: Invalid API key format. Should start with 'sk_'");
    process.exit(1);
  }

  // Validate API key against relay
  const { RelayClient } = await import("../relay-client.js");
  const relay = new RelayClient(apiKey);
  log("  Validating API key...");
  try {
    // Just validate the key is valid — don't need WhatsApp connected for Baileys
    await relay.getWhatsAppStatus();
    log("  API key valid");
  } catch (err: any) {
    log(`  Error: ${err.message}`);
    log("  Check your API key and try again.");
    process.exit(1);
  }

  // Neon DB
  let neonUrl = await askForNeonUrl();
  await setupDatabase(neonUrl);

  // Pairing code connection
  const { runBaileysSetup } = await import("../providers/baileys-setup.js");
  const baileysAuthDir = resolve(homedir(), ".vida", "baileys-auth");

  log("");
  const result = await runBaileysSetup(baileysAuthDir);
  log("");

  // Write config
  const whatsappServer = {
    command: "npx",
    args: ["-y", "@vidaai/whatsapp-mcp"],
    env: {
      VIDA_PROVIDER: "baileys",
      VIDA_API_KEY: apiKey,
      NEON_DATABASE_URL: neonUrl,
      VIDA_BAILEYS_AUTH: result.authDir,
    },
  };

  const written = writeConfigToClaude(whatsappServer);
  printSuccess(written, whatsappServer);
}

// ── Helpers ──

async function askForNeonUrl(): Promise<string> {
  let neonUrl = process.env.NEON_DATABASE_URL || "";
  if (!neonUrl) {
    log("");
    log("  Your messages are stored in YOUR own database (we never have access).");
    log("  You need a PostgreSQL database — Neon is free at neon.tech");
    log("");
    neonUrl = await ask("  Neon DATABASE_URL: ");
  }
  if (!neonUrl.includes("postgresql") && !neonUrl.includes("postgres")) {
    log("  Error: Invalid database URL. Should start with postgresql://");
    process.exit(1);
  }
  return neonUrl;
}

function printSuccess(configWritten: boolean, whatsappServer: any) {
  log("");
  log("  Setup complete!");
  log("");

  if (!configWritten) {
    log("  Add this to your ~/.claude/.mcp.json (Claude Code)");
    log("  or claude_desktop_config.json (Claude Desktop):");
    log("");
    log(JSON.stringify({ mcpServers: { whatsapp: whatsappServer } }, null, 2));
    log("");
  }

  log("  Restart Claude Code, then try: 'show me my WhatsApp messages'");
  log("");
}

// ── Main ──

async function main() {
  log("");
  log("  WhatsApp MCP Setup");
  log("  ==================");
  log("");
  log("  How do you want to connect WhatsApp?");
  log("");
  log("  [1] Cloud API — WhatsApp Business, official, E2E encrypted ($25/mo)");
  log("  [2] Personal — WhatsApp personal, QR code scan ($25/mo)");
  log("      Uses unofficial third-party API. VIDA AI is not affiliated.");
  log("");

  const choice = await ask("  Choose (1 or 2): ");

  if (choice === "2") {
    await setupBaileys();
  } else {
    await setupCloudApi();
  }
}

main().catch((err) => {
  log(`  Fatal error: ${err.message}`);
  process.exit(1);
});
