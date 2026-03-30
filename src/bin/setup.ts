#!/usr/bin/env node

/**
 * WhatsApp MCP Setup CLI
 *
 * Interactive setup that:
 * 1. Validates API key against relay
 * 2. Generates X25519 keypair (private key stays local)
 * 3. Registers public key with relay (activates webhooks)
 * 4. Runs Drizzle migrations on user's Neon DB
 * 5. Prints .mcp.json config for Claude Code/Desktop
 *
 * Usage: npx @vidaai/whatsapp-mcp setup
 */

import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { generateKeyPair, loadPrivateKey } from "../crypto.js";
import { RelayClient } from "../relay-client.js";
import { createDb } from "../db/index.js";
import { contacts, conversations, messages, actionItems, syncState } from "../db/schema.js";
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
  // Use stderr for all output (stdout reserved for JSON-RPC in MCP mode)
  process.stderr.write(msg + "\n");
}

async function main() {
  log("");
  log("  WhatsApp MCP Setup");
  log("  ==================");
  log("");

  // Step 1: API Key
  let apiKey = process.env.VIDA_API_KEY || "";
  if (!apiKey) {
    apiKey = await ask("  API key (from vidaai.co/mcp): ");
  }
  if (!apiKey.startsWith("sk_")) {
    log("  Error: Invalid API key format. Should start with 'sk_'");
    process.exit(1);
  }

  // Validate API key against relay
  const relay = new RelayClient(apiKey);
  log("  Validating API key...");
  try {
    const status = await relay.getWhatsAppStatus();
    if (status.connected) {
      log(`  WhatsApp connected: ${status.displayPhone || "yes"}`);
      if (status.isCoexistence) {
        log("");
        log("  Note: Your number is in coexistence mode.");
        log("  Messages you send from your phone won't appear here.");
        log("  For full coverage, migrate your number to the API.");
        log("");
      }
    } else {
      log("  WhatsApp not yet connected. Connect at vidaai.co/mcp first.");
      process.exit(1);
    }
  } catch (err: any) {
    log(`  Error: ${err.message}`);
    log("  Check your API key and try again.");
    process.exit(1);
  }

  // Step 2: Neon Database URL
  let neonUrl = process.env.NEON_DATABASE_URL || "";
  if (!neonUrl) {
    log("");
    log("  Where do you want to store your messages?");
    log("  You need a PostgreSQL database (Neon recommended — free at neon.tech)");
    log("");
    neonUrl = await ask("  Neon DATABASE_URL: ");
  }
  if (!neonUrl.includes("postgresql") && !neonUrl.includes("postgres")) {
    log("  Error: Invalid database URL. Should start with postgresql://");
    process.exit(1);
  }

  // Test DB connection
  log("  Testing database connection...");
  try {
    const testSql = neon(neonUrl);
    const testDb = drizzle(testSql);
    await testDb.execute(sql`SELECT 1`);
    log("  Database connected OK");
  } catch (err: any) {
    log(`  Error: Cannot connect to database — ${err.message}`);
    process.exit(1);
  }

  // Step 3: Run migrations (create tables)
  log("  Creating tables...");
  try {
    const migSql = neon(neonUrl);
    const migDb = drizzle(migSql);

    // Create tables directly (simpler than running migration files)
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
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

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
  } catch (err: any) {
    log(`  Error creating tables: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Generate keypair
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
    log("  IMPORTANT: This key is your only way to decrypt messages.");
    log("  Back it up securely. If you lose it, your messages are unrecoverable.");
  }

  // Step 5: Register public key + activate webhooks
  log("  Registering public key and activating webhooks...");
  try {
    await relay.registerKey(publicKeyBase64);
    log("  Webhooks activated OK");
  } catch (err: any) {
    log(`  Error: ${err.message}`);
    process.exit(1);
  }

  // Step 6: Auto-add config to Claude Code
  const whatsappServer = {
    command: "npx",
    args: ["-y", "@vidaai/whatsapp-mcp"],
    env: {
      VIDA_API_KEY: apiKey,
      NEON_DATABASE_URL: neonUrl,
      VIDA_KEY_PATH: keyPath,
    },
  };

  const mcpJsonPath = resolve(homedir(), ".claude", ".mcp.json");
  let configWritten = false;

  try {
    // Read existing config or start fresh
    let mcpConfig: any = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      const existing = readFileSync(mcpJsonPath, "utf-8");
      mcpConfig = JSON.parse(existing);
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } else {
      // Ensure ~/.claude/ directory exists
      mkdirSync(dirname(mcpJsonPath), { recursive: true });
    }

    // Add/update whatsapp server entry
    mcpConfig.mcpServers.whatsapp = whatsappServer;
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
    log(`  Config written to ${mcpJsonPath}`);
    configWritten = true;
  } catch (err: any) {
    log(`  Could not auto-write config: ${err.message}`);
    log("  You can add it manually (see below).");
  }

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

main().catch((err) => {
  log(`  Fatal error: ${err.message}`);
  process.exit(1);
});
