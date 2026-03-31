import makeWASocket, { useMultiFileAuthState, fetchLatestWaWebVersion, DisconnectReason } from '@whiskeysockets/baileys';
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

const authDir = resolve(homedir(), '.vida', 'baileys-test-pair3');
try { rmSync(authDir, { recursive: true, force: true }); } catch {}
mkdirSync(authDir, { recursive: true });

let version;
try {
  const v = await fetchLatestWaWebVersion({});
  version = v.version;
  console.error('  WA version:', version);
} catch(e) {
  console.error('  Version fetch failed:', e.message);
}

// Reconnect loop — like Evolution API does
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    ...(version ? { version } : {}),
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    console.error('  [event] connection:', connection || '-', 'qr:', !!qr, 'code:', lastDisconnect?.error?.output?.statusCode || '-');

    if (qr && !pairingRequested) {
      pairingRequested = true;
      try {
        await new Promise(r => setTimeout(r, 1000));
        const code = await sock.requestPairingCode(phone);
        console.error('');
        console.error('  =============================');
        console.error('  PAIRING CODE: ' + code);
        console.error('  =============================');
        console.error('  WhatsApp → Linked Devices → Link a Device → Link with phone number');
        console.error('');
      } catch(e) {
        console.error('  Pairing code error:', e.message);
      }
    }

    if (connection === 'open') {
      console.error('  CONNECTED! User: ' + sock.user?.id);
      console.error('  Auth state saved. You can close this now.');
      setTimeout(() => { sock.end(undefined); process.exit(0); }, 3000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.error('  Closed with code:', statusCode, shouldReconnect ? '— reconnecting...' : '— logged out');

      if (shouldReconnect) {
        // Reconnect after short delay
        setTimeout(() => connectToWhatsApp(), 2000);
      } else {
        process.exit(1);
      }
    }
  });
}

connectToWhatsApp();
setTimeout(() => { console.error('  TIMEOUT'); process.exit(1); }, 180000);
