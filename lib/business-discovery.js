// lib/business-discovery.js
// Correctif 2026-09-15 (8e passage), demandé par Luc ("tout le monde était
// lié sur Instagram, mais ça ne récupère pas les informations de tout le
// monde") : la synchro Business Discovery n'existait qu'en version "un
// profil à la fois" (bouton "🔄 Synchroniser" dans le panneau), il fallait
// donc cliquer manuellement profil par profil pour que les followers/
// engagement/tags remontent — normal que "tout le monde" n'ait pas encore
// ses infos juste après le rattrapage des liaisons.
//
// Ce fichier extrait la logique Business Discovery (déjà écrite dans
// api/profiles/[id]/sync-business.js) dans une fonction réutilisable, pour
// pouvoir l'appeler soit sur UN profil (bouton existant, comportement
// inchangé), soit en BOUCLE sur tous les profils liés d'un tenant (nouveau
// bouton "🔄 Synchroniser tous les profils", voir
// api/profiles/sync-all-business.js) sans dupliquer le code Graph API.
const { withTenant, withoutTenant } = require('./db');
const { decrypt } = require('./crypto');
const { logAudit } = require('./audit');

const GRAPH_VERSION = 'v21.0';
const MEDIA_LIMIT = 15; // "15 derniers posts" demandé par Luc pour la fiche détaillée

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
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag]) => tag);
}

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
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([handle]) => handle);
}

class SyncError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.code = code;
    this.detail = detail;
  }
}

async function getBusinessDiscoveryCredential(tenantId) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_business_discovery'`,
      [tenantId]
    );
    return rows[0] || null;
  });
}

// cred est optionnel : si non fourni (cas du bouton "un profil"), il est
// relu ici ; en boucle (sync-all), l'appelant le lit UNE fois et le passe à
// chaque appel pour éviter une lecture + un déchiffrement par profil.
async function syncOneInfluenceAccount(tenantId, accountId, cred) {
  if (!cred) {
    cred = await getBusinessDiscoveryCredential(tenantId);
  }
  if (!cred) {
    throw new SyncError('facebook_not_connected', 'Connecte d\'abord Facebook pour cette marque (bouton "Connecter Facebook").');
  }

  const hasRelation = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM tenant_influence_relations WHERE tenant_id = $1 AND account_id = $2`,
      [tenantId, accountId]
    );
    return rows.length > 0;
  });
  if (!hasRelation) {
    throw new SyncError('profile_not_found_for_tenant');
  }

  const account = await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id, instagram_handle FROM influence_accounts WHERE id = $1', [accountId]);
    return rows[0] || null;
  });
  if (!account) throw new SyncError('profile_not_found');
  if (!account.instagram_handle) {
    throw new SyncError('instagram_handle_missing', 'Aucun handle Instagram enregistré pour ce profil.');
  }

  let pageAccessToken;
  let igBusinessAccountId;
  try {
    pageAccessToken = decrypt(cred.encrypted_value);
    igBusinessAccountId = cred.metadata && cred.metadata.ig_business_account_id;
  } catch (err) {
    throw new SyncError('decrypt_failed');
  }
  if (!igBusinessAccountId) throw new SyncError('ig_business_account_id_missing');

  const handle = String(account.instagram_handle).replace(/^@/, '');
  // Correctif 2026-09-15 (9e passage), demandé par Luc : fiche influenceuse
  // plus complète façon Stellar.io, avec la grille des derniers posts
  // (vignette, likes, commentaires, date, lien) — on récupère donc media_type
  // (pour distinguer photo/carrousel de vidéo, seul proxy "reel" disponible
  // ici) et les URLs d'image, en plus des champs déjà utilisés. On reste
  // strictement sur les champs DOCUMENTÉS comme disponibles via Business
  // Discovery (pas de media_product_type/insights — ceux-là ne sont exposés
  // que pour un compte qu'on possède, pas pour un compte tiers, et les
  // demander ferait échouer tout l'appel). Limite assumée sur media_url/
  // thumbnail_url : ce sont des URLs SIGNÉES fournies par Meta qui expirent
  // au bout de quelques heures — on les affiche juste après une synchro
  // fraîche, jamais garanties valables plus tard (voir le repli "lien only"
  // côté front si l'image ne charge plus).
  const fields =
    `business_discovery.username(${handle}){followers_count,media_count,profile_picture_url,name,` +
    `media.limit(${MEDIA_LIMIT}){caption,like_count,comments_count,timestamp,permalink,media_type,media_url,thumbnail_url}}`;
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${igBusinessAccountId}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', pageAccessToken);

  let json;
  let resp;
  try {
    resp = await fetch(url.toString());
    json = await resp.json();
  } catch (err) {
    throw new SyncError('meta_api_error', null, (err && err.message) || String(err));
  }
  if (!resp.ok) {
    // Correctif 2026-09-15 (10e passage), demandé par Luc ("est-ce que les
    // comptes privés ne remontent pas les infos ?", cas réel observé sur le
    // ticket "kamarwen") : Business Discovery ne fonctionne QUE sur un
    // compte Instagram Business/Créateur PUBLIC. Un compte privé, un compte
    // personnel non-pro (même public), ou un handle inexistant renvoient
    // TOUS exactement la même erreur Meta : code 110 "Invalid user id" /
    // error_user_msg "L'utilisateur(ice) avec le nom de profil « X » est
    // introuvable." Ce n'est pas un bug côté plateforme, c'est une limite
    // documentée de l'API — mais le JSON brut de Meta ne le dit pas
    // explicitement, d'où la confusion. On détecte ce code précis pour
    // donner tout de suite un message clair au lieu du JSON brut.
    const metaError = json && json.error;
    if (metaError && metaError.code === 110) {
      throw new SyncError(
        'business_discovery_account_not_eligible',
        `Impossible de récupérer les stats de @${handle} : ce compte est privé, introuvable, ou n'est pas un compte Instagram professionnel (Business/Créateur). Business Discovery (l'API Meta utilisée ici) ne fonctionne QUE sur les comptes pro publics — ce n'est pas réparable côté plateforme.`,
        metaError
      );
    }
    throw new SyncError('meta_api_error', null, JSON.stringify(json));
  }

  const discovery = json.business_discovery;
  if (!discovery) throw new SyncError('business_discovery_empty', null, json);

  const media = (discovery.media && discovery.media.data) || [];
  const followerCount = discovery.followers_count || 0;
  let engagementObserved = null;
  if (followerCount > 0 && media.length > 0) {
    const rates = media.map((m) => ((m.like_count || 0) + (m.comments_count || 0)) / followerCount);
    engagementObserved = Number(((rates.reduce((a, b) => a + b, 0) / rates.length) * 100).toFixed(2));
  }
  const frequentTags = extractHashtags(media.map((m) => m.caption));
  const mentionedAccounts = extractMentions(media.map((m) => m.caption));

  // Correctif 2026-09-15 (9e passage) : fréquence de publication (moyenne en
  // jours entre deux posts consécutifs, sur l'échantillon récupéré — pas
  // "vraie" sur toute la vie du compte, juste sur les MEDIA_LIMIT derniers
  // posts, comme le reste des stats ici) et posts bruts conservés pour la
  // fiche détaillée (vignette, likes, commentaires, date, lien, type).
  let postingFrequencyDays = null;
  const timestamps = media.map((m) => m.timestamp).filter(Boolean).map((t) => new Date(t).getTime()).sort((a, b) => b - a);
  if (timestamps.length >= 2) {
    const spanMs = timestamps[0] - timestamps[timestamps.length - 1];
    postingFrequencyDays = Number((spanMs / (timestamps.length - 1) / 86400000).toFixed(1));
  }
  const lastPosts = media.map((m) => ({
    permalink: m.permalink || null,
    caption: m.caption || null,
    like_count: m.like_count || 0,
    comments_count: m.comments_count || 0,
    timestamp: m.timestamp || null,
    media_type: m.media_type || null,
    thumbnail_url: m.thumbnail_url || null,
    media_url: m.media_url || null,
  }));

  const updated = await withoutTenant(async (client) => {
    const { rows } = await client.query(
      `UPDATE influence_accounts
       SET follower_count = $2,
           engagement_observed = $3,
           profile_picture_url = COALESCE($4, profile_picture_url),
           frequent_tags = $5,
           mentioned_accounts = $6,
           last_posts = $7,
           posting_frequency_days = $8,
           instagram_synced_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [accountId, followerCount, engagementObserved, discovery.profile_picture_url || null, frequentTags, mentionedAccounts, JSON.stringify(lastPosts), postingFrequencyDays]
    );
    return rows[0];
  });

  await withTenant(tenantId, async (client) => {
    await logAudit(client, tenantId, {
      actor: 'system:sync-business',
      action: 'influence_profile_synced',
      entityType: 'influence_account',
      entityId: accountId,
      details: { follower_count: followerCount, engagement_observed: engagementObserved, media_count_used: media.length },
    });
  });

  return { account: updated, media_count_used: media.length };
}

module.exports = { syncOneInfluenceAccount, getBusinessDiscoveryCredential, SyncError };
