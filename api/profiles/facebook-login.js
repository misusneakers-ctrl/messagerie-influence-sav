// GET /api/profiles/facebook-login?tenant=bbp|misu
// Démarre le flux "Facebook Login for Business" pour connecter une Page
// Facebook (et le compte Instagram professionnel qui lui est lié) à l'app
// Meta bbp-messagerie, afin de pouvoir ensuite interroger l'API Business
// Discovery (followers, engagement, posts publics d'un compte tiers) —
// correctif 2026-09-15, demandé par Luc pour le panneau "qualité
// influenceuse". Simple redirection HTTP, pas de JSON : ce endpoint est
// pensé pour être ouvert directement dans le navigateur (lien/bouton dans
// index.html), jamais appelé en fetch().
//
// Pourquoi un tenant en query string et pas le header X-Tenant-Slug habituel
// (voir lib/tenant.js) : une redirection plein-écran vers Facebook ne peut
// pas porter de header personnalisé, contrairement à un fetch() classique.
// Le slug est donc passé ici, puis reporté tel quel dans le paramètre
// `state` OAuth pour être récupéré par facebook-callback.js une fois
// Facebook redirigé en retour.
const { resolveTenantBySlug } = require('../../lib/tenant');

// ID d'app Meta bbp-messagerie (visible publiquement dans le tableau de bord
// Meta for Developers — ce n'est pas un secret, contrairement au client
// secret qui ne doit jamais figurer dans ce dépôt).
const META_APP_ID = '1776379956832524';

// Doit correspondre EXACTEMENT à l'URI de redirection déclarée dans
// Meta for Developers > bbp-messagerie > Facebook Login for Business >
// Paramètres > URI de redirection OAuth valides (déjà fait le 15/09/2026).
const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/profiles/facebook-callback';

// Permissions déjà ajoutées côté Meta (cas d'utilisation "API Instagram" >
// "Configuration de l'API avec la connexion Facebook") le 15/09/2026.
const SCOPES = [
  'instagram_basic',
  'instagram_content_publishing',
  'instagram_manage_messages',
  'pages_read_engagement',
  'pages_show_list',
  'business_management',
].join(',');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const tenantSlug = req.query && req.query.tenant;
  if (!tenantSlug) {
    res.status(400).send('Paramètre ?tenant=bbp ou ?tenant=misu manquant.');
    return;
  }

  const tenant = await resolveTenantBySlug(String(tenantSlug));
  if (!tenant) {
    res.status(404).send(`Marque inconnue : "${tenantSlug}".`);
    return;
  }

  const authorizeUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  authorizeUrl.searchParams.set('client_id', META_APP_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('state', tenant.slug);
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('response_type', 'code');

  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
};
