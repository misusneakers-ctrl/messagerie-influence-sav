// POST /api/profiles/[id]/sync-business
// Va chercher automatiquement, via l'API Business Discovery de Meta, les
// infos publiques d'un influenceur tiers à partir de son handle Instagram
// déjà enregistré (influence_accounts.instagram_handle) : photo de profil,
// nombre de followers, taux d'engagement estimé et tags fréquents déduits
// des derniers posts. Correctif 2026-09-15, suite du panneau "qualité
// influenceuse" — nécessite que la marque (tenant) ait connecté Facebook
// Login for Business au préalable (bouton "🔗 Connecter Facebook",
// credential tenant_credentials de type 'meta_business_discovery' posé par
// api/profiles/facebook-callback.js).
//
// Limites assumées, à connaître avant de lire les chiffres obtenus :
// - Business Discovery ne renvoie que les ~25 posts les plus RÉCENTS du
//   compte, sans filtre par date : on ne peut pas garantir "les posts des
//   90 derniers jours" si le compte publie peu souvent, on prend les 12
//   plus récents disponibles, point.
// - Le "taux d'engagement" est calculé ici comme
//   moyenne((likes+commentaires)/followers) sur ces posts récupérés — une
//   estimation usuelle mais pas un chiffre officiel Meta.
// - email et âge restent hors de portée de toute API Meta : ils ne sont
//   jamais touchés par cet endpoint (voir api/profiles/[id].js pour leur
//   édition manuelle).
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant, withoutTenant } = require('../../../lib/db');
const { decrypt } = require('../../../lib/crypto');
const { logAudit } = require('../../../lib/audit');

const GRAPH_VERSION = 'v21.0';
const MEDIA_LIMIT = 12;

function extractHashtags(captions) {
  const counts = new Map();
  for (const caption of captions) {
    if (!caption) continue;
    const matches = caption.match(/#[\p{L}0-9_]+/gu) || [];
    for (const raw of matches) {
      const tag = raw.slice(1).toLowerCase();
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);
}

// Correctif 2026-09-15 (5e passage), demandé par Luc : comptes @mentionnés
// dans le texte des posts (captions), en plus des hashtags — même méthode
// d'extraction. Limite assumée : ce sont les mentions dans la LÉGENDE du
// post, pas les tags visuels posés directement sur la photo (people tagged
// in photo) — ces derniers ne sont pas exposés par l'API Business Discovery
// pour un compte tiers, aucun moyen technique de les récupérer.
function extractMentions(captions) {
  const counts = new Map();
  for (const caption of captions) {
    if (!caption) continue;
    const matches = caption.match(/@[\p{L}0-9._]+/gu) || [];
    for (const raw of matches) {
      const handle = raw.slice(1).toLowerCase().replace(/[._]+$/, '');
      if (!handle) continue;
      counts.set(handle, (counts.get(handle) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([handle]) => handle);
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  const { id } = req.query || {};
  if (!id) {
    sendJson(res, 400, { error: 'id_required' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const [hasRelation, cred] = await Promise.all([
    withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM tenant_influence_relations WHERE tenant_id = $1 AND account_id = $2`,
        [tenant.id, id]
      );
      return rows.length > 0;
    }),
    withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_business_discovery'`,
        [tenant.id]
      );
      return rows[0] || null;
    }),
  ]);

  if (!hasRelation) {
    sendJson(res, 404, { error: 'profile_not_found_for_tenant' });
    return;
  }
  if (!cred) {
    sendJson(res, 400, {
      error: 'facebook_not_connected',
      message: 'Connecte d\'abord Facebook pour cette marque (bouton "Connecter Facebook").',
    });
    return;
  }

  const account = await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id, instagram_handle FROM influence_accounts WHERE id = $1', [id]);
    return rows[0] || null;
  });
  if (!account) {
    sendJson(res, 404, { error: 'profile_not_found' });
    return;
  }
  if (!account.instagram_handle) {
    sendJson(res, 400, { error: 'instagram_handle_missing', message: 'Aucun handle Instagram enregistré pour ce profil.' });
    return;
  }

  let pageAccessToken;
  let igBusinessAccountId;
  try {
    pageAccessToken = decrypt(cred.encrypted_value);
    igBusinessAccountId = cred.metadata && cred.metadata.ig_business_account_id;
  } catch (err) {
    sendJson(res, 500, { error: 'decrypt_failed' });
    return;
  }
  if (!igBusinessAccountId) {
    sendJson(res, 500, { error: 'ig_business_account_id_missing' });
    return;
  }

  const handle = String(account.instagram_handle).replace(/^@/, '');
  const fields =
    `business_discovery.username(${handle}){followers_count,media_count,profile_picture_url,name,` +
    `media.limit(${MEDIA_LIMIT}){caption,like_count,comments_count,timestamp,permalink}}`;
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${igBusinessAccountId}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', pageAccessToken);

  let json;
  try {
    const resp = await fetch(url.toString());
    json = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(json));
  } catch (err) {
    sendJson(res, 502, { error: 'meta_api_error', detail: (err && err.message) || String(err) });
    return;
  }

  const discovery = json.business_discovery;
  if (!discovery) {
    sendJson(res, 502, { error: 'business_discovery_empty', detail: json });
    return;
  }

  const media = (discovery.media && discovery.media.data) || [];
  const followerCount = discovery.followers_count || 0;
  let engagementObserved = null;
  if (followerCount > 0 && media.length > 0) {
    const rates = media.map((m) => ((m.like_count || 0) + (m.comments_count || 0)) / followerCount);
    engagementObserved = Number(((rates.reduce((a, b) => a + b, 0) / rates.length) * 100).toFixed(2));
  }
  const frequentTags = extractHashtags(media.map((m) => m.caption));
  const mentionedAccounts = extractMentions(media.map((m) => m.caption));

  const updated = await withoutTenant(async (client) => {
    const { rows } = await client.query(
      `UPDATE influence_accounts
       SET follower_count = $2,
           engagement_observed = $3,
           profile_picture_url = COALESCE($4, profile_picture_url),
           frequent_tags = $5,
           mentioned_accounts = $6,
           instagram_synced_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, followerCount, engagementObserved, discovery.profile_picture_url || null, frequentTags, mentionedAccounts]
    );
    return rows[0];
  });

  await withTenant(tenant.id, async (client) => {
    await logAudit(client, tenant.id, {
      actor: 'system:sync-business',
      action: 'influence_profile_synced',
      entityType: 'influence_account',
      entityId: id,
      details: { follower_count: followerCount, engagement_observed: engagementObserved, media_count_used: media.length },
    });
  });

  sendJson(res, 200, { account: updated, media_count_used: media.length });
});
