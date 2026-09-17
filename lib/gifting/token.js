// lib/gifting/token.js
// Ajout 2026-09-16 (commande gifting) : gestion du jeton Shopify de l'app
// de gifting. Deux formats possibles selon ce que Shopify renvoie à la
// connexion :
// - jeton permanent (cas des apps personnalisées, comme bbp-sav-readonly) :
//   stocké tel quel ;
// - jeton expirant (~60 min) + refresh_token (format OAuth 2.0 que Shopify
//   généralise depuis déc. 2025) : stocké en JSON chiffré, rafraîchi
//   automatiquement ici 5 minutes avant expiration.
const { encrypt } = require('../crypto');
const { appCredentials } = require('./oauth');

function serializeToken(tokenJson) {
  if (tokenJson.refresh_token && tokenJson.expires_in) {
    return JSON.stringify({
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at: Date.now() + Number(tokenJson.expires_in) * 1000,
    });
  }
  return tokenJson.access_token;
}

function parseStored(stored) {
  const s = String(stored || '');
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch { /* jeton brut */ }
  }
  return { access_token: s };
}

async function getValidAccessToken({ client, tenant, shopDomain, stored }) {
  const tok = parseStored(stored);
  if (!tok.refresh_token || !tok.expires_at || Date.now() < Number(tok.expires_at) - 5 * 60 * 1000) {
    return tok.access_token;
  }
  const app = appCredentials(tenant.slug);
  if (!app) {
    const err = new Error('shopify_gifting_app_not_configured');
    err.code = 'shopify_gifting_app_not_configured';
    throw err;
  }
  const resp = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: tok.refresh_token,
    }).toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    const err = new Error('shopify_gifting_refresh_failed');
    err.code = 'shopify_gifting_refresh_failed';
    throw err;
  }
  await client.query(
    `UPDATE tenant_credentials SET encrypted_value = $1, updated_at = now() WHERE tenant_id = $2 AND type = 'shopify_gifting'`,
    [encrypt(serializeToken({ ...json, refresh_token: json.refresh_token || tok.refresh_token })), tenant.id]
  );
  return json.access_token;
}

module.exports = { serializeToken, parseStored, getValidAccessToken };
