// Génère une clé de chiffrement 32 octets encodée en base64, à poser une
// seule fois comme CREDENTIALS_ENCRYPTION_KEY sur Vercel. Ne jamais la
// recopier ailleurs (chat, dépôt, logs).
const { generateKey } = require('../lib/crypto');
console.log(generateKey());
