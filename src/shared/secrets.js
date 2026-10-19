import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Local stand-in for the external secrets-manager (REQ-011, NFR-002). Secrets are held only as
 * AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ciphertext>`, base64url parts); the 32-byte master key
 * comes from separate configuration. `getGatewayCredentials()` decrypts in memory on every call
 * and nothing is cached or persisted. A real deployment swaps this for a Vault / AWS Secrets
 * Manager client exposing the same `getGatewayCredentials()` method.
 */

const ALGORITHM = 'aes-256-gcm';

function parseMasterKey(masterKey) {
  const key = Buffer.from(masterKey ?? '', 'base64');
  if (key.length !== 32) throw new Error('secrets master key must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plaintext, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, parseMasterKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(sealed, masterKey) {
  const [version, iv, tag, ciphertext] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
    throw new Error('encrypted secret is malformed');
  }
  const decipher = createDecipheriv(ALGORITHM, parseMasterKey(masterKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * @param {{ encryptedGatewayCredentials: string, masterKey: string }} config
 *   `encryptedGatewayCredentials` decrypts to JSON `{ "key_id": "...", "key_secret": "..." }`.
 */
export function createEncryptedSecretsManager({ encryptedGatewayCredentials, masterKey }) {
  return {
    async getGatewayCredentials() {
      const { key_id: keyId, key_secret: keySecret } = JSON.parse(
        decryptSecret(encryptedGatewayCredentials, masterKey),
      );
      if (!keyId || !keySecret) throw new Error('gateway credentials must contain key_id and key_secret');
      return { keyId, keySecret };
    },
  };
}

// CLI: node src/shared/secrets.js '<plaintext>'   (uses SECRETS_MASTER_KEY; prints a new key if unset)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let masterKey = process.env.SECRETS_MASTER_KEY;
  if (!masterKey) {
    masterKey = randomBytes(32).toString('base64');
    console.error(`SECRETS_MASTER_KEY was not set; generated one:\nSECRETS_MASTER_KEY=${masterKey}`);
  }
  const plaintext = process.argv[2];
  if (!plaintext) {
    console.error(`usage: SECRETS_MASTER_KEY=... node src/shared/secrets.js '{"key_id":"...","key_secret":"..."}'`);
    process.exit(2);
  }
  console.log(encryptSecret(plaintext, masterKey));
}
