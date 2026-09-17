// GET /api/gifting/shopify-callback?code=...&hmac=...&shop=...&state=...
// Ajout 2026-09-16 (commande gifting) : retour de la connexion OAuth Shopify
// démarrée par shopify-connect.js. Vérifie la signature Shopify (hmac) et
// l'état signé (anti-rejeu, 15 min), échange le code côté serveur, contrôle
// que les droits accordés contiennent write_draft_orders, puis stocke le token
// CHIFFRÉ en base (tenant_credentials type 'shopify_gifting'). Le token
// n'apparaît jamais à l'écran ni dans les logs.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { withTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');
const { appCredentials, readStateSlug, verifyState, verifyShopifyHmac, isValidShopDomain } = require('../../lib/gifting/oauth');
const { getShopIdentity } = require('../../lib/gifting/shopify-admin');
const { serializeToken } = require('../../lib/gifting/token');

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
    res.status(400).send(page('Connexion Shopify annulée', `<p>${esc(q.error_description || q.error)}</p>`));
    return;
  }
  const slug = readStateSlug(q.state);
  const tenant = slug ? await resolveTenantBySlug(slug) : null;
  const app = tenant ? appCredentials(tenant.slug) : null;
  if (!tenant || !app) {
    res.status(400).send(page('Erreur', '<p>Marque inconnue ou configuration Vercel manquante.</p>'));
    return;
  }
  if (!verifyState(q.state, app.clientSecret)) {
    res.status(400).send(page('Lien expiré', '<p>La demande de connexion a expiré ou est invalide. Relance « 🔗 Connecter Shopify » depuis la messagerie.</p>'));
    return;
  }
  if (!verifyShopifyHmac(q, app.clientSecret) || !isValidShopDomain(q.shop) || !q.code) {
    res.status(400).send(page('Signature invalide', '<p>Le retour ne vient pas de Shopify (signature incorrecte). Rien n\'a été enregistré.</p>'));
    return;
  }

  try {
    const tokenResp = await fetch(`https://${q.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code: String(q.code) }).toString(),
    });
    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenJson.access_token) {
      throw new Error(`échange du code refusé par Shopify (HTTP ${tokenResp.status})`);
    }
    const scope = String(tokenJson.scope || '');
    if (!/write_draft_orders/.test(scope)) {
      res.status(200).send(page('Droits insuffisants',
        `<p>Shopify a accordé les droits <code>${esc(scope) || 'aucun'}</code> mais pas <code>write_draft_orders</code>.</p>
         <p>Ajoute ce droit (et <code>read_orders</code>) dans la configuration de l'app sur le Dev Dashboard, publie la version, puis relance la connexion.</p>`));
      return;
    }
    const identity = await getShopIdentity({ shopDomain: q.shop, accessToken: tokenJson.access_token }).catch(() => null);
    const metadata = {
      shop: q.shop,
      scope,
      shop_name: identity ? identity.name : null,
      myshopify_domain: identity ? identity.myshopifyDomain : null,
      primary_domain: identity && identity.primaryDomain ? identity.primaryDomain.host : null,
      connected_at: new Date().toISOString(),
    };
    await withTenant(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1, 'shopify_gifting', $2, $3)
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
        [tenant.id, encrypt(serializeToken(tokenJson)), JSON.stringify(metadata)]
      );
      await logAudit(client, tenant.id, {
        actor: 'manual', action: 'shopify_gifting_connected', entityType: 'tenant_credentials', entityId: null, details: metadata,
      });
    });
    res.status(200).send(page(`✅ Shopify connecté pour ${esc(tenant.name)}`,
      `<p>Boutique : <strong>${esc(metadata.shop_name || q.shop)}</strong> (${esc(metadata.primary_domain || q.shop)})<br>
       Droits : <code>${esc(scope)}</code></p>
       <p>Vérifie que c'est bien la boutique de ${esc(tenant.name)}, puis ferme cet onglet et retourne sur la messagerie.</p>`, true));
  } catch (err) {
    res.status(502).send(page('Erreur pendant la connexion', `<p><code>${esc(err.message)}</code></p>`));
  }
};
