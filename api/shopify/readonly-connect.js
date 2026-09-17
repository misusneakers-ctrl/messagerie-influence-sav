// GET /api/shopify/readonly-connect?tenant=bbp|misu
// Ajout 2026-09-17 : démarre la (re)connexion OAuth de l'app Shopify de
// LECTURE (bbp-sav-readonly / misu-sav-readonly), avec les droits
// read_orders + read_all_orders — ce dernier est ce qui permet à Alice de
// retrouver une commande de plus de 60 jours.
// À ouvrir dans le navigateur, connecté à l'admin Shopify de la marque.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { REDIRECT_URI, SCOPES, appCredentials, signState } = require('../../lib/shopify/readonly-oauth');

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
    res.status(500).send(`Configuration manquante sur Vercel : SHOPIFY_READONLY_CLIENT_ID_${key} et SHOPIFY_READONLY_CLIENT_SECRET_${key}.`);
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
