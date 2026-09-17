// GET /api/shopify/readonly-callback?code=...&hmac=...&shop=...&state=...
// Ajout 2026-09-17 : retour de la connexion démarrée par readonly-connect.js.
// Vérifie la signature Shopify (hmac) et l'état signé (anti-rejeu, 15 min),
// échange le code côté serveur, contrôle que `read_all_orders` a bien été
// accordé, puis remplace le jeton CHIFFRÉ en base (tenant_credentials type
// 'shopify_readonly'). Le jeton n'apparaît jamais à l'écran ni dans les logs.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { withTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');
const { appCredentials, readStateSlug, verifyState, verifyShopifyHmac, isValidShopDomain } = require('../../lib/shopify/readonly-oauth');
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
    res.status(400).send(page('Lien expiré', '<p>La demande de connexion a expiré ou est invalide. Relance la connexion depuis le lien fourni.</p>'));
    return;
  }
  if (!verifyShopifyHmac(q, app.clientSecret) || !isValidShopDomain(q.shop) || !q.code) {
    res.status(400).send(page('Signature invalide', "<p>Le retour ne vient pas de Shopify (signature incorrecte). Rien n'a été enregistré.</p>"));
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
    if (!/read_orders/.test(scope)) {
      res.status(200).send(page('Droits insuffisants',
        `<p>Shopify a accordé <code>${esc(scope) || 'aucun droit'}</code>, sans <code>read_orders</code>. Rien n'a été enregistré.</p>`));
      return;
    }
    // Le jeton est enregistré même sans read_all_orders (il vaut toujours
    // mieux que rien : 60 jours d'historique), mais on le dit clairement.
    const allOrders = /read_all_orders/.test(scope);
    const identity = await getShopIdentity({ shopDomain: q.shop, accessToken: tokenJson.access_token }).catch(() => null);
    const metadata = {
      shop: q.shop,
      scope,
      read_all_orders: allOrders,
      shop_name: identity ? identity.name : null,
      myshopify_domain: identity ? identity.myshopifyDomain : null,
      primary_domain: identity && identity.primaryDomain ? identity.primaryDomain.host : null,
      connected_at: new Date().toISOString(),
    };
    await withTenant(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1, 'shopify_readonly', $2, $3)
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
        [tenant.id, encrypt(serializeToken(tokenJson)), JSON.stringify(metadata)]
      );
      await logAudit(client, tenant.id, {
        actor: 'manual', action: 'shopify_readonly_connected', entityType: 'tenant_credentials', entityId: null, details: metadata,
      });
    });
    res.status(200).send(page(
      `✅ Lecture Shopify reconnectée pour ${esc(tenant.name)}`,
      `<p>Boutique : <strong>${esc(metadata.shop_name || q.shop)}</strong> (${esc(metadata.primary_domain || q.shop)})<br>
       Droits : <code>${esc(scope)}</code></p>
       <p>${allOrders
        ? "Tout l'historique des commandes est désormais lisible : Alice peut retrouver une commande de plus de 60 jours."
        : "⚠️ <code>read_all_orders</code> n'a pas été accordé : seules les commandes des 60 derniers jours restent visibles."}</p>
       <p>Ferme cet onglet et retourne sur la messagerie.</p>`,
      allOrders
    ));
  } catch (err) {
    res.status(502).send(page('Erreur pendant la connexion', `<p><code>${esc(err.message)}</code></p>`));
  }
};
