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

// Correctif 2026-09-15 (2e passage) : la première version demandait aussi
// instagram_content_publishing et instagram_manage_messages (listées comme
// "requises" dans le tableau de bord Meta pour le cas d'utilisation
// complet), mais Facebook a refusé la demande avec "Invalid Scope:
// instagram_content_publishing" au moment de l'autorisation — ces deux
// permissions ne sont accordables qu'après un Contrôle app (App Review)
// plus poussé, non fait, et de toute façon inutiles ici : on ne fait QUE de
// la lecture publique (Business Discovery), jamais de publication ni
// d'envoi de message via ce token-là.
//
// Correctif 2026-09-15 (4e passage) : la synchro échouait avec "(#10)
// Application does not have permission for this action" — il manquait
// `instagram_manage_insights`, qui est la permission qui porte réellement
// la fonctionnalité Business Discovery ("découvrir et lire les informations
// de profil et les contenus multimédia d'autres profils professionnels",
// exactement ce qu'on fait dans sync-business.js). Elle a été ajoutée côté
// app Meta (statut "Prête pour le test") et doit donc aussi être demandée
// ici dans le scope OAuth, sinon le token obtenu ne l'a pas.
const SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
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
