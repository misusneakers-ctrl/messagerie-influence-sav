// GET /api/sav/order-context?order_number=1234
// Lecture seule du contexte Shopify pour traiter un ticket SAV, y compris le
// statut de retour. Ne modifie jamais rien côté Shopify.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');
const { getOrderContext } = require('../../lib/channels/shopify-readonly');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const orderNumber = req.query.order_number;
  if (!orderNumber) {
    sendJson(res, 400, { error: 'order_number_required' });
    return;
  }

  const cred = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_readonly'`,
      [tenant.id]
    );
    return rows[0] || null;
  });

  if (!cred) {
    sendJson(res, 409, { error: 'shopify_readonly_not_configured_for_tenant' });
    return;
  }

  try {
    const accessToken = decrypt(cred.encrypted_value);
    const context = await getOrderContext({
      shopDomain: tenant.myshopify_domain,
      accessToken,
      orderNumber,
      tenantSlug: tenant.slug,
    });
    if (!context) {
      sendJson(res, 404, { error: 'order_not_found' });
      return;
    }
    sendJson(res, 200, { order: context });
  } catch (err) {
    console.error('Erreur lecture Shopify (SAV)', err);
    sendJson(res, 502, { error: 'shopify_read_failed' });
  }
});
