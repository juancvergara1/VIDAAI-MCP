#!/usr/bin/env node

/**
 * WhatsApp MCP Server — read, search, and send WhatsApp messages from Claude.
 *
 * Usage:
 *   npx @vidaai/whatsapp-mcp          — start MCP server (stdio)
 *   npx @vidaai/whatsapp-mcp setup    — interactive setup wizard
 *
 * IMPORTANT: Never use console.log() in MCP mode — it corrupts stdio JSON-RPC.
 * Use console.error() for all logging.
 */

// Route to setup wizard if "setup" argument passed
if (process.argv.includes("setup")) {
  import("./bin/setup.js");
} else {
  // Start MCP server
  import("./server.js").then(({ startServer }) => startServer()).catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}
