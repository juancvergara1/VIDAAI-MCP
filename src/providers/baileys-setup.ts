/**
 * Baileys first-time setup — connects to WhatsApp via pairing code.
 * Separated from the runtime provider so setup.ts can use it independently.
 */

import { resolve } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a.trim()); }));
}

export interface BaileysSetupResult {
  phoneNumber: string;
  authDir: string;
}

export async function runBaileysSetup(authDir: string): Promise<BaileysSetupResult> {
  const resolvedDir = authDir.startsWith("~")
    ? resolve(homedir(), authDir.slice(2))
    : resolve(authDir);

  // Import everything upfront
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, fetchLatestWaWebVersion, DisconnectReason } = baileys;
  const pino = (await import("pino")).default;
  const { mkdirSync, rmSync, existsSync } = await import("fs");

  // Clear old auth state to force fresh pairing
  if (existsSync(resolvedDir)) {
    try { rmSync(resolvedDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  mkdirSync(resolvedDir, { recursive: true });

  // Get phone number for pairing code
  const phone = await ask("  Phone number (with country code, no +, e.g. 573001234567): ");
  if (!phone || phone.length < 10) {
    throw new Error("Invalid phone number.");
  }

  // Fetch latest WA protocol version
  let version: [number, number, number] | undefined;
  try {
    const v = await fetchLatestWaWebVersion({});
    version = v.version;
  } catch { /* use Baileys default */ }

  log("");
  log("  Connecting to WhatsApp...");

  return new Promise<BaileysSetupResult>((resolveSetup, reject) => {
    let settled = false;

    async function connect() {
      const { state, saveCreds } = await useMultiFileAuthState(resolvedDir);

      // NO browser option when using pairing code (critical for successful pairing)
      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        ...(version ? { version } : {}),
      });

      sock.ev.on("creds.update", saveCreds);

      let pairingRequested = false;

      sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // Request pairing code when QR is generated (instead of showing QR)
        if (qr && !pairingRequested) {
          pairingRequested = true;
          try {
            await new Promise(r => setTimeout(r, 1000));
            const code = await sock.requestPairingCode(phone);
            log("");
            log("  =============================");
            log(`  PAIRING CODE: ${code}`);
            log("  =============================");
            log("");
            log("  On your phone:");
            log("  WhatsApp → Linked Devices → Link a Device");
            log("  → Link with phone number instead");
            log(`  Enter the code: ${code}`);
            log("");
          } catch (e: any) {
            log(`  Pairing code error: ${e.message}`);
          }
        }

        if (connection === "open" && !settled) {
          settled = true;
          let phoneNumber = "";
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

          // Give WA a moment to finalize, then close
          setTimeout(() => {
            try { sock.end(undefined); } catch { /* ignore */ }
            resolveSetup({ phoneNumber: phoneNumber || phone, authDir: resolvedDir });
          }, 3000);
        }

        if (connection === "close" && !settled) {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            // 515 after pairing is normal — reconnect
            log("  Reconnecting...");
            setTimeout(() => connect(), 2000);
          } else {
            settled = true;
            reject(new Error("Connection rejected. Try again."));
          }
        }
      });
    }

    connect();

    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Pairing timeout. Run setup again."));
      }
    }, 180000);
  });
}
