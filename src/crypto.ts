/**
 * Sealed Box Decryption — E2E decryption for MCP client.
 *
 * Uses tweetnacl sealed boxes (X25519 + XSalsa20-Poly1305).
 * The private key lives ONLY on the user's machine (~/.vida/private.key).
 * The relay server NEVER has access to the private key.
 */

import nacl from "tweetnacl";
import { open } from "tweetnacl-sealedbox-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

const DEFAULT_KEY_DIR = resolve(homedir(), ".vida");
const DEFAULT_KEY_PATH = resolve(DEFAULT_KEY_DIR, "private.key");

/**
 * Generate a new X25519 keypair.
 * Private key saved to disk. Public key returned for registration.
 */
export function generateKeyPair(keyPath?: string): { publicKey: string; secretKey: string; keyPath: string } {
  const targetPath = keyPath || DEFAULT_KEY_PATH;
  const keyPair = nacl.box.keyPair();

  const publicKey = Buffer.from(keyPair.publicKey).toString("base64");
  const secretKey = Buffer.from(keyPair.secretKey).toString("base64");

  // Ensure directory exists
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Save private key
  writeFileSync(targetPath, secretKey, { mode: 0o600 }); // Owner read/write only

  return { publicKey, secretKey, keyPath: targetPath };
}

/**
 * Load the private key from disk.
 */
export function loadPrivateKey(keyPath?: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const targetPath = keyPath || DEFAULT_KEY_PATH;

  if (!existsSync(targetPath)) {
    throw new Error(`Private key not found at ${targetPath}. Run 'whatsapp-mcp setup' first.`);
  }

  const secretKeyBase64 = readFileSync(targetPath, "utf-8").trim();
  const secretKey = new Uint8Array(Buffer.from(secretKeyBase64, "base64"));

  if (secretKey.length !== 32) {
    throw new Error(`Invalid private key length: expected 32 bytes, got ${secretKey.length}`);
  }

  // Derive public key from secret key
  const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);

  return { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };
}

/**
 * Decrypt a sealed box blob.
 * @param encryptedBase64 - Base64-encoded sealed box
 * @param publicKey - User's public key (Uint8Array)
 * @param secretKey - User's private key (Uint8Array)
 * @returns Decrypted plaintext string, or null if decryption fails
 */
export function sealDecrypt(
  encryptedBase64: string,
  publicKey: Uint8Array,
  secretKey: Uint8Array
): string | null {
  const encrypted = new Uint8Array(Buffer.from(encryptedBase64, "base64"));
  const decrypted = open(encrypted, publicKey, secretKey);

  if (!decrypted) {
    return null; // Decryption failed (wrong key or corrupted data)
  }

  return new TextDecoder().decode(decrypted);
}
