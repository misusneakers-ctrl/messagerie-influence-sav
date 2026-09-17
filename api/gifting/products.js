// GET /api/gifting/products?q=elisabeth léopard
// GET /api/gifting/products?quota_sku=1-S25-EPLEO-BLA-38
// Ajout 2026-09-16 (commande gifting) : recherche de produits sur les
// données PUBLIQUES de la boutique (variantes, pointures, disponibilité) pour
// la fenêtre « Commande gifting », et compteur de quota d'un modèle/coloris.
// Lecture seule.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { searchProducts } = require('../../lib/ai/stock');
const { getQuotaForSku } = require('../../lib/gifting/orders');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (req.query.quota_sku) {
    const quota = await getQuotaForSku(tenant, String(req.query.quota_sku));
    sendJson(res, 200, { quota });
    return;
  }
  const q = String(req.query.q || '').trim();
  if (!q) {
    sendJson(res, 400, { error: 'q_required' });
    return;
  }
  try {
    const products = await searchProducts({ shopDomain: tenant.myshopify_domain, query: q, limit: 6 });
    sendJson(res, 200, { products });
  } catch (err) {
    sendJson(res, 502, { error: err.code || 'shop_unreachable' });
  }
});
