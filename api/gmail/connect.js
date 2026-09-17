// GET /api/gmail/connect?tenant=bbp|misu
// Ajout 2026-09-17 : démarre la connexion Google de la boîte e-mail SAV de la
// marque (lecture gmail.readonly + envoi gmail.send — voir lib/gmail/client.js).
// À ouvrir depuis « ✨ Assistante IA » → « 📧 Connecter la boîte e-mail SAV ».
// Sur l'écran Google, choisir le compte Hello (la boîte SAV), pas un compte
// personnel : c'est depuis cette adresse que partiront les réponses.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { signState } = require('../../lib/gifting/oauth');
const { REDIRECT_URI, SCOPES, googleAppCredentials } = require('../../lib/gmail/client');

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
  const app = googleAppCredentials();
  if (!app) {
    res.status(500).send('Configuration manquante sur Vercel : GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET.');
    return;
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', signState(tenant.slug, app.clientSecret));
  res.writeHead(302, { Location: url.toString() });
  res.end();
};
