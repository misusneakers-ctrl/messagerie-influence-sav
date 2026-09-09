// Webhook RGPD obligatoire : effacement des données d'un client.
// Anonymise les champs de contact dans les tickets de ce client pour cette
// boutique ; ne touche jamais influence_accounts (l'effacement client Shopify
// ne concerne pas les profils influence, sujets distincts).
const { readRawBody } = require('../../../lib/rawBody');
const { verifyShopifyHmac } = require('../../../lib/shopifyWebhookAuth');
const { withoutTenant, withTenant } = require('../../../lib/db');
const { logAudit } = require('../../../lib/audit');

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
  const customerEmail = payload.customer?.email;

  const tenantId = await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id FROM tenants WHERE myshopify_domain = $1', [shopDomain]);
    return rows[0]?.id || null;
  });

  if (tenantId && customerEmail) {
    await withTenant(tenantId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE tickets SET contact_name = '[effacé]', contact_email = '[effacé]', contact_handle = contact_handle
         WHERE tenant_id = $1 AND contact_email = $2`,
        [tenantId, customerEmail]
      );
      await logAudit(client, tenantId, {
        actor: 'shopify_webhook',
        action: 'customers_redact',
        entityType: 'customer',
        entityId: null,
        details: { customer_email: customerEmail, tickets_redacted: rowCount },
      });
    });
  }

  res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: false } };
