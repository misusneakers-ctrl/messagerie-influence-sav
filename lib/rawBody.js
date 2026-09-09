// Lit le corps brut d'une requête Vercel (bodyParser désactivé) — nécessaire
// pour vérifier une signature HMAC Meta/Shopify calculée sur les octets exacts
// reçus, avant tout parsing JSON.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { readRawBody };
