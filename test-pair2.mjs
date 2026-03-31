import makeWASocket, { useMultiFileAuthState, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

const phone = await ask('  Phone number (no +, e.g. 573123887373): ');

const authDir = resolve(homedir(), '.vida', 'baileys-test-pair2');
try { rmSync(authDir, { recursive: true, force: true }); } catch {}
mkdirSync(authDir, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(authDir);

// Fetch version like Evolution API does
let version;
try {
  const v = await fetchLatestWaWebVersion({});
  version = v.version;
  console.error('  WA version:', version);
} catch(e) {
  console.error('  Version fetch failed:', e.message);
}

// NO browser option when using pairing code (like Evolution API)
const sock = makeWASocket({
  auth: state,
  logger: P({ level: 'silent' }),
  ...(version ? { version } : {}),
});

sock.ev.on('creds.update', saveCreds);

let pairingRequested = false;

sock.ev.on('connection.update', async (update) => {
  const { connection, lastDisconnect, qr } = update;

  // When QR is generated, request pairing code instead (like Evolution API)
  if (qr && !pairingRequested) {
    pairingRequested = true;
    try {
      // Small delay like Evolution API does
      await new Promise(r => setTimeout(r, 1000));
      const code = await sock.requestPairingCode(phone);
      console.error('');
      console.error('  =============================');
      console.error('  PAIRING CODE: ' + code);
      console.error('  =============================');
      console.error('');
      console.error('  On your phone:');
      console.error('  WhatsApp → Linked Devices → Link a Device');
      console.error('  → Link with phone number instead');
      console.error('  Enter the code above.');
      console.error('');
    } catch(e) {
      console.error('  Pairing code error:', e.message);
    }
  }

  if (connection === 'open') {
    console.error('  CONNECTED! User: ' + sock.user?.id);
    sock.end(undefined);
    process.exit(0);
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    console.error('  Connection closed. Code:', code);
  }
});

setTimeout(() => { console.error('  TIMEOUT'); process.exit(1); }, 120000);
