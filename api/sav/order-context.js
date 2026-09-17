// GET /api/sav/order-context?order_number=1234
// Lecture seule du contexte Shopify pour traiter un ticket SAV, y compris le
// statut de retour. Ne modifie jamais rien côté Shopify.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { getOrderContext } = require('../../lib/channels/shopify-readonly');
const { getReadonlyAccessToken } = require('../../lib/shopify/readonly-token');

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

  // Correctif 2026-09-17 : lecture du jeton déléguée à
  // lib/shopify/readonly-token.js (jeton permanent OU jeton OAuth expirant
  // rafraîchi automatiquement).
  const accessToken = await getReadonlyAccessToken(tenant);

  if (!accessToken) {
    sendJson(res, 409, { error: 'shopify_readonly_not_configured_for_tenant' });
    return;
  }

  try {
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
