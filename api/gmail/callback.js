// GET /api/gmail/callback?code=...&state=...&scope=...
// Ajout 2026-09-17 (enquête d'Alice) : retour de la connexion Google démarrée
// par api/gmail/connect.js. Vérifie l'état signé (15 min), échange le code
// côté serveur, exige le droit gmail.readonly, lit l'adresse de la boîte
// connectée, puis stocke le jeton de rafraîchissement CHIFFRÉ
// (tenant_credentials type 'gmail_readonly'). Aucun jeton n'est affiché.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { withTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');
const { readStateSlug, verifyState } = require('../../lib/gifting/oauth');
const { REDIRECT_URI, SCOPE, googleAppCredentials } = require('../../lib/gmail/client');

function page(title, body, ok) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.5;color:#1a1a1a}
h1{font-size:20px;color:${ok ? '#1a7f37' : '#b3261e'}}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const q = req.query || {};
  if (q.error) {
    res.status(400).send(page('Connexion Google annulée', `<p>${esc(q.error)}</p>`));
    return;
  }
  const app = googleAppCredentials();
  const slug = readStateSlug(q.state);
  const tenant = slug ? await resolveTenantBySlug(slug) : null;
  if (!app || !tenant) {
    res.status(400).send(page('Erreur', '<p>Lien invalide : relance « 📧 Connecter la boîte e-mail SAV » depuis la messagerie (ne pas ouvrir cette page directement).</p>'));
    return;
  }
  if (!verifyState(q.state, app.clientSecret) || !q.code) {
    res.status(400).send(page('Lien expiré', '<p>La demande de connexion a expiré ou est invalide. Relance la connexion depuis la messagerie.</p>'));
    return;
  }
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId, client_secret: app.clientSecret, code: String(q.code),
        grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    const token = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !token.access_token) throw new Error(`échange du code refusé par Google (${token.error || tokenResp.status})`);
    if (!String(token.scope || '').split(' ').includes(SCOPE)) {
      res.status(200).send(page('Droit refusé', "<p>Google n'a pas accordé la lecture des e-mails. Relance la connexion et coche l'accès demandé.</p>"));
      return;
    }
    if (!token.refresh_token) {
      res.status(200).send(page('Connexion incomplète', "<p>Google n'a pas fourni de jeton durable. Retire l'accès de l'application dans ton compte Google (Sécurité → Applications tierces), puis relance la connexion.</p>"));
      return;
    }
    const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const profile = await profileResp.json().catch(() => ({}));
    const metadata = { email: profile.emailAddress || null, scope: SCOPE, connected_at: new Date().toISOString() };
    await withTenant(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1, 'gmail_readonly', $2, $3)
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
        [tenant.id, encrypt(JSON.stringify({ refresh_token: token.refresh_token })), JSON.stringify(metadata)]
      );
      await logAudit(client, tenant.id, { actor: 'manual', action: 'gmail_connected', entityType: 'tenant_credentials', entityId: null, details: metadata });
    });
    res.status(200).send(page(`✅ Boîte e-mail connectée pour ${esc(tenant.name)}`,
      `<p>Boîte : <strong>${esc(metadata.email || 'inconnue')}</strong> — lecture seule.</p>
       <p>Vérifie que c'est bien la boîte SAV de ${esc(tenant.name)}, puis ferme cet onglet et retourne sur la messagerie.</p>`, true));
  } catch (err) {
    res.status(502).send(page('Erreur pendant la connexion', `<p><code>${esc(err.message)}</code></p>`));
  }
};
