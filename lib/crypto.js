// Chiffrement AES-256-GCM des credentials par tenant (tenant_credentials.encrypted_value).
// Format stocké : base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext)
// La clé ne circule jamais ailleurs que dans la variable d'environnement Vercel
// CREDENTIALS_ENCRYPTION_KEY (32 octets, jamais recopiée dans le chat ni le dépôt).

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY manquant');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY doit encoder exactement 32 octets en base64');
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(stored) {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = String(stored).split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Valeur chiffrée mal formée');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Génère une clé 32 octets encodée en base64, à poser une seule fois sur Vercel. */
function generateKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { encrypt, decrypt, generateKey };
