// Webhook RGPD obligatoire : effacement des données d'une boutique entière
// (48h après désinstallation de l'app, envoyé par Shopify). Journalise la
// demande — la suppression effective des données du tenant est une décision
// à valider manuellement par Luc, pas une action automatique destructrice.
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
  const shopDomain = req.headers['x-shopify-shop-domain'];

  const tenantId = await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id FROM tenants WHERE myshopify_domain = $1', [shopDomain]);
    return rows[0]?.id || null;
  });

  if (tenantId) {
    await withTenant(tenantId, async (client) => {
      await logAudit(client, tenantId, {
        actor: 'shopify_webhook',
        action: 'shop_redact_requested',
        entityType: 'tenant',
        entityId: tenantId,
        details: { shop_domain: shopDomain, note: 'Suppression effective à valider manuellement, non automatisée.' },
      });
    });
  }

  res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: false } };
