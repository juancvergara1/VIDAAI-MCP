#!/usr/bin/env node
/**
 * Patches Baileys to use MACOS platform instead of WEB.
 * WhatsApp servers reject Platform.WEB (value 14) since Feb 2026.
 * Changing to MACOS (value 24) resolves the 405 Connection Failure.
 *
 * See: https://github.com/WhiskeySockets/Baileys/pull/2377
 *
 * Run automatically via npm postinstall.
 */

const { readFileSync, writeFileSync, existsSync } = require("fs");
const { resolve } = require("path");

const filePath = resolve(__dirname, "..", "node_modules", "@whiskeysockets", "baileys", "lib", "Utils", "validate-connection.js");

if (!existsSync(filePath)) {
  console.log("[patch-baileys] Baileys not found, skipping patch.");
  process.exit(0);
}

let content = readFileSync(filePath, "utf-8");

if (content.includes("Platform.MACOS")) {
  console.log("[patch-baileys] Already patched.");
  process.exit(0);
}

if (!content.includes("Platform.WEB")) {
  console.log("[patch-baileys] Platform.WEB not found, skipping.");
  process.exit(0);
}

content = content.replace(
  "platform: proto.ClientPayload.UserAgent.Platform.WEB,",
  "platform: proto.ClientPayload.UserAgent.Platform.MACOS,"
);

writeFileSync(filePath, content, "utf-8");
console.log("[patch-baileys] Patched Platform.WEB → Platform.MACOS (405 fix)");
