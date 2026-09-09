// Webhook RGPD obligatoire : demande d'accès aux données d'un client.
// Le noyau messagerie ne stocke pas de données personnelles clientes en
// dehors des tickets/messages où ce client apparaît en contact — recense-les
// et journalise la demande. La réponse effective à la demande (export) reste
// une action manuelle de Luc tant qu'aucun export automatique n'est câblé.
const { readRawBody } = require('../../../lib/rawBody');
const { verifyShopifyHmac } = require('../../../lib/shopifyWebhookAuth');
const { withoutTenant, withTenant } = require('../../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const rawBody = await readRawBody(req);
  if (!verifyShopifyHmac(req, rawBody)) {
    res.status(401).json({ error: 'invalid_hmac' });
    return;
  }
  const payload = JSON.parse(rawBody.toString('utf8') || '{}');
  const shopDomain = req.headers['x-shopify-shop-domain'];

  const tenantId = await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id FROM tenants WHERE myshopify_domain = $1', [shopDomain]);
    return rows[0]?.id || null;
  });

  if (tenantId) {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, details)
         VALUES ($1, 'shopify_webhook', 'customers_data_request', 'customer', NULL, $2)`,
        [tenantId, JSON.stringify({ customer: payload.customer, orders_requested: payload.orders_requested || [] })]
      );
    });
  }

  res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: false } };
