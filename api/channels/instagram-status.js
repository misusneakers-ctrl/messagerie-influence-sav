// GET /api/channels/instagram-status
// Diagnostic en lecture seule : vérifie que la credential Instagram posée
// pour la marque résolue (X-Tenant-Slug) fonctionne réellement, sans jamais
// exposer le token lui-même. Appelle graph.instagram.com/me avec le token
// déchiffré côté serveur, renvoie juste l'identité du compte et si elle
// correspond bien à l'ig_business_account_id attendu en metadata.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const cred = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata, updated_at FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    return rows[0] || null;
  });

  if (!cred) {
    sendJson(res, 200, { connected: false, reason: 'no_credential_configured' });
    return;
  }

  let accessToken;
  try {
    accessToken = decrypt(cred.encrypted_value);
  } catch (err) {
    sendJson(res, 200, { connected: false, reason: 'decrypt_failed' });
    return;
  }

  const expectedId = cred.metadata?.ig_business_account_id || null;

  try {
    const url = `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`;
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.id) {
      sendJson(res, 200, {
        connected: false,
        reason: 'graph_api_error',
        detail: payload.error?.message || `HTTP ${response.status}`,
        // Code d'erreur Meta utile pour distinguer "token expiré" (190) d'un
        // autre problème, sans jamais renvoyer le token concerné.
        error_code: payload.error?.code || null,
      });
      return;
    }

    sendJson(res, 200, {
      connected: true,
      account_id: payload.id,
      username: payload.username || null,
      matches_expected_account: expectedId ? payload.id === expectedId : null,
      credential_updated_at: cred.updated_at,
    });
  } catch (err) {
    sendJson(res, 200, { connected: false, reason: 'network_error', detail: err.message });
  }
});
