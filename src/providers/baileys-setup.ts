/**
 * Baileys first-time setup — connects to WhatsApp via QR code scan.
 * Separated from the runtime provider so setup.ts can use it independently.
 *
 * All output goes to stderr (stdout reserved for MCP JSON-RPC).
 */

import { resolve } from "path";
import { homedir } from "os";

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

export interface BaileysSetupResult {
  phoneNumber: string;
  authDir: string;
}

export async function runBaileysSetup(authDir: string): Promise<BaileysSetupResult> {
  // Resolve ~ to home directory
  const resolvedDir = authDir.startsWith("~")
    ? resolve(homedir(), authDir.slice(2))
    : resolve(authDir);

  // Dynamic imports
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, DisconnectReason } = baileys;
  const pino = (await import("pino")).default;
  const qrcode = await import("qrcode-terminal");

  const { mkdirSync } = await import("fs");
  mkdirSync(resolvedDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(resolvedDir);
  const logger = pino({ level: "silent" });

  log("  Connecting to WhatsApp...");
  log("  Scan the QR code with your phone:");
  log("  WhatsApp → Settings → Linked Devices → Link a Device");
  log("");

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["VIDA AI MCP", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  return new Promise<BaileysSetupResult>((resolveSetup, reject) => {
    let settled = false;
    let phoneNumber = "";

    // Show QR code in terminal (to stderr)
    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Generate QR and output to stderr
        qrcode.generate(qr, { small: true }, (qrStr: string) => {
          // qrcode-terminal writes to stdout by default, we capture and redirect
          process.stderr.write(qrStr + "\n");
        });
      }

      if (connection === "open" && !settled) {
        settled = true;

        // Get connected phone number
        try {
          const me = sock.user;
          phoneNumber = me?.id?.replace(/:.*@/, "@").replace("@s.whatsapp.net", "") || "";
          if (phoneNumber) {
            log(`  Connected as +${phoneNumber}`);
          } else {
            log("  Connected to WhatsApp.");
          }
        } catch {
          log("  Connected to WhatsApp.");
        }

        // Close connection after successful auth (setup only, not runtime)
        try {
          sock.end(undefined);
        } catch { /* ignore */ }

        resolveSetup({
          phoneNumber,
          authDir: resolvedDir,
        });
      }

      if (connection === "close" && !settled) {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          settled = true;
          reject(new Error("Connection rejected. Try again."));
        }
        // Otherwise Baileys will auto-retry
      }
    });

    // Timeout after 120s (QR expires after ~60s, gives time for 2 attempts)
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { sock.end(undefined); } catch { /* ignore */ }
        reject(new Error("QR scan timeout. Run setup again."));
      }
    }, 120000);
  });
}
