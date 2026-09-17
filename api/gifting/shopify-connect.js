// GET /api/gifting/shopify-connect?tenant=bbp|misu
// Ajout 2026-09-16 (commande gifting) : démarre la connexion OAuth de l'app
// Shopify dédiée aux commandes de gifting (scopes write_draft_orders +
// read_orders). À ouvrir dans le navigateur (bouton dans « ✨ Assistante IA »),
// connecté à l'admin Shopify de la marque. Voir lib/gifting/oauth.js.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { REDIRECT_URI, SCOPES, appCredentials, signState } = require('../../lib/gifting/oauth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const slug = req.query && req.query.tenant;
  const tenant = slug ? await resolveTenantBySlug(String(slug)) : null;
  if (!tenant) {
    res.status(400).send('Paramètre ?tenant=bbp ou ?tenant=misu manquant ou inconnu.');
    return;
  }
  const app = appCredentials(tenant.slug);
  if (!app) {
    const key = tenant.slug.toUpperCase();
    res.status(500).send(`Configuration manquante sur Vercel : SHOPIFY_GIFTING_CLIENT_ID_${key} et SHOPIFY_GIFTING_CLIENT_SECRET_${key}.`);
    return;
  }
  const url = new URL(`https://${tenant.myshopify_domain}/admin/oauth/authorize`);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', signState(tenant.slug, app.clientSecret));
  res.writeHead(302, { Location: url.toString() });
  res.end();
};
