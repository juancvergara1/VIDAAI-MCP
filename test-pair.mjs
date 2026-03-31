import makeWASocket, { useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

const phone = await ask('  Phone number (with country code, no +, e.g. 573150634091): ');

const authDir = resolve(homedir(), '.vida', 'baileys-test-pair');
try { rmSync(authDir, { recursive: true, force: true }); } catch {}
mkdirSync(authDir, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(authDir);

let version;
try { version = (await fetchLatestBaileysVersion()).version; console.error('  WA version:', version); } catch {}

const sock = makeWASocket({
  auth: state,
  logger: P({ level: 'silent' }),
  browser: Browsers.macOS('Chrome'),
  ...(version ? { version } : {}),
});

sock.ev.on('creds.update', saveCreds);

let pairingRequested = false;

sock.ev.on('connection.update', async (update) => {
  if (update.qr && !pairingRequested) {
    pairingRequested = true;
    try {
      const code = await sock.requestPairingCode(phone);
      console.error('');
      console.error('  =============================');
      console.error('  PAIRING CODE: ' + code);
      console.error('  =============================');
      console.error('');
      console.error('  On your phone:');
      console.error('  WhatsApp → Linked Devices → Link a Device → Link with phone number');
      console.error('  Enter the code above.');
      console.error('');
    } catch(e) {
      console.error('  Pairing code error:', e.message);
    }
  }
  if (update.connection === 'open') {
    console.error('  CONNECTED! User: ' + sock.user?.id);
    sock.end(undefined);
    process.exit(0);
  }
  if (update.connection === 'close') {
    const code = update.lastDisconnect?.error?.output?.statusCode;
    console.error('  Connection closed. Code:', code);
    if (code !== 515) process.exit(1);
  }
});

setTimeout(() => { console.error('  TIMEOUT'); process.exit(1); }, 120000);
