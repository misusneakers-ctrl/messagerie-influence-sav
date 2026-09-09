// Vérification HMAC des webhooks RGPD Shopify (X-Shopify-Hmac-Sha256).
const crypto = require('crypto');

function verifyShopifyHmac(req, rawBody) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

module.exports = { verifyShopifyHmac };
