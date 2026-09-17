// lib/shopify/readonly-token.js
// Ajout 2026-09-17 : lecture du jeton `shopify_readonly` en base, quel que
// soit son format.
// - jeton permanent `shpat_...` (celui posé à la main le 11/09) : rendu tel
//   quel ;
// - jeton OAuth expirant (~60 min) + refresh_token, format que Shopify
//   généralise : rafraîchi automatiquement 5 minutes avant expiration, puis
//   réenregistré chiffré.
// Le jeton n'apparaît jamais à l'écran ni dans les logs.
const { withTenant } = require('../db');
const { decrypt, encrypt } = require('../crypto');
const { serializeToken, parseStored } = require('../gifting/token');
const { appCredentials } = require('./readonly-oauth');

async function refresh(client, tenant, tok) {
  const app = appCredentials(tenant.slug);
  if (!app) {
    const err = new Error('shopify_readonly_app_not_configured');
    err.code = 'shopify_readonly_app_not_configured';
    throw err;
  }
  const resp = await fetch(`https://${tenant.myshopify_domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
    }).toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    const err = new Error('shopify_readonly_refresh_failed');
    err.code = 'shopify_readonly_refresh_failed';
    throw err;
  }
  await client.query(
    `UPDATE tenant_credentials SET encrypted_value = $1, updated_at = now()
      WHERE tenant_id = $2 AND type = 'shopify_readonly'`,
    [encrypt(serializeToken({ ...json, refresh_token: json.refresh_token || tok.refresh_token })), tenant.id]
  );
  return json.access_token;
}

/**
 * Jeton d'accès utilisable pour l'API Admin (lecture seule), ou null si la
 * marque n'a pas de credential `shopify_readonly`.
 */
async function getReadonlyAccessToken(tenant) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_readonly'`,
      [tenant.id]
    );
    if (!rows[0]) return null;
    const tok = parseStored(decrypt(rows[0].encrypted_value));
    if (!tok.refresh_token || !tok.expires_at || Date.now() < Number(tok.expires_at) - 5 * 60 * 1000) {
      return tok.access_token || null;
    }
    return refresh(client, tenant, tok);
  });
}

/** Droits réellement accordés au jeton en place (metadata de la credential). */
async function getReadonlyScopes(tenant) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_readonly'`,
      [tenant.id]
    );
    return rows[0] && rows[0].metadata ? String(rows[0].metadata.scope || '') : '';
  });
}

module.exports = { getReadonlyAccessToken, getReadonlyScopes };
