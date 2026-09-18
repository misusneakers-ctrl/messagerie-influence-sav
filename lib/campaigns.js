// lib/influence/campaigns.js
// Ajout 2026-09-18, demandé par Luc : « Il me faudra une sorte de tag de
// participation à une campagne, et voir si elle a publié. Par exemple : a
// reçu. Et moi après je fais : a publié une fois, deux fois, trois fois,
// quatre fois. Ou pas du tout. »
//
// Et, dit par lui juste après, la vraie raison : « c'est surtout pour
// l'exclusion des filles qui ne posteraient pas ». Tout ce module est écrit
// pour ça : le comptage n'est pas une statistique, c'est ce qui permet de ne
// pas envoyer une deuxième paire à quelqu'un qui n'a rien publié de la
// première. D'où `accountRecord()`, lu par l'assistante avant toute
// recommandation de gifting.
//
// Le comptage est manuel (bouton « +1 publication ») : c'est Luc qui décide
// ce qui compte. L'API Instagram ne voit que les posts du fil, pas les
// stories — elle ne peut donc que SUGGÉRER, jamais trancher (voir
// `suggestPostsFromMentions`).

const STATUSES = ['pressentie', 'acceptee', 'a_recu', 'a_publie', 'n_a_pas_publie', 'exclue'];

// Une participante qui a reçu sa paire et n'a rien publié au bout de ce
// délai est signalée « en retard ». Ce n'est pas un statut enregistré : la
// situation évolue toute seule avec le temps, la stocker la figerait.
const DELAI_PUBLICATION_JOURS = 21;

/** Statuts qui signifient « la paire est partie chez elle ». */
const RECUS = ['a_recu', 'a_publie', 'n_a_pas_publie'];

function isStatus(value) {
  return STATUSES.includes(String(value || ''));
}

function joursDepuis(date) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

/**
 * Enrichit une ligne de participation avec ce qui se déduit du temps qui
 * passe — jamais stocké, toujours recalculé.
 */
function decorate(row) {
  if (!row) return row;
  const jours = joursDepuis(row.received_at);
  const aRecu = RECUS.includes(row.status) || !!row.received_at;
  return {
    ...row,
    posts_count: Number(row.posts_count || 0),
    a_recu: aRecu,
    jours_depuis_reception: jours,
    // Le signal qui intéresse Luc : reçu, rien publié, et le délai est passé.
    en_retard: aRecu && Number(row.posts_count || 0) === 0
      && row.status !== 'n_a_pas_publie' && row.status !== 'exclue'
      && jours != null && jours >= DELAI_PUBLICATION_JOURS,
  };
}

// ---------------------------------------------------------------------------
// Campagnes
// ---------------------------------------------------------------------------

async function listCampaigns(client, tenantId) {
  const { rows } = await client.query(
    `SELECT c.*,
            COUNT(p.id)                                        AS participantes,
            COUNT(p.id) FILTER (WHERE p.status = ANY($2))      AS ont_recu,
            COUNT(p.id) FILTER (WHERE p.posts_count > 0)       AS ont_publie,
            COALESCE(SUM(p.posts_count), 0)                    AS publications
       FROM campaigns c
       LEFT JOIN campaign_participants p ON p.campaign_id = c.id AND p.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 200`,
    [tenantId, RECUS]
  );
  return rows.map((r) => ({
    ...r,
    participantes: Number(r.participantes),
    ont_recu: Number(r.ont_recu),
    ont_publie: Number(r.ont_publie),
    publications: Number(r.publications),
  }));
}

async function createCampaign(client, tenantId, { name, objective, offer, budget_or_product }) {
  const label = String(name || '').trim().slice(0, 120);
  if (!label) {
    const err = new Error('name_required');
    err.code = 'name_required';
    throw err;
  }
  const { rows } = await client.query(
    `INSERT INTO campaigns (tenant_id, name, objective, offer, budget_or_product, status)
     VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
    [tenantId, label, objective || null, offer || null, budget_or_product || null]
  );
  return rows[0];
}

/** Participantes d'une campagne, avec de quoi les reconnaître à l'écran. */
async function listParticipants(client, tenantId, campaignId) {
  const { rows } = await client.query(
    `SELECT p.*, a.display_name, a.instagram_handle, a.profile_picture_url,
            a.shoe_size, r.score_total, r.relationship_status
       FROM campaign_participants p
       JOIN influence_accounts a ON a.id = p.account_id
       JOIN tenant_influence_relations r ON r.id = p.relation_id
      WHERE p.tenant_id = $1 AND p.campaign_id = $2
      ORDER BY p.posts_count DESC, a.display_name ASC`,
    [tenantId, campaignId]
  );
  return rows.map(decorate);
}

// ---------------------------------------------------------------------------
// Participation
// ---------------------------------------------------------------------------

/**
 * Ajoute une influenceuse à une campagne. Idempotent : rejouer l'ajout ne
 * crée pas de doublon et n'écrase pas un suivi déjà commencé.
 */
async function addParticipant(client, tenantId, { campaignId, relationId, status = 'pressentie' }) {
  if (!isStatus(status)) {
    const err = new Error('statut_inconnu');
    err.code = 'statut_inconnu';
    throw err;
  }
  const { rows: rel } = await client.query(
    `SELECT id, account_id FROM tenant_influence_relations WHERE id = $1 AND tenant_id = $2`,
    [relationId, tenantId]
  );
  if (!rel[0]) {
    const err = new Error('relation_introuvable');
    err.code = 'relation_introuvable';
    throw err;
  }
  const { rows } = await client.query(
    `INSERT INTO campaign_participants (tenant_id, campaign_id, relation_id, account_id, status,
                                        received_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = ANY($6) THEN now() ELSE NULL END)
     ON CONFLICT (campaign_id, relation_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [tenantId, campaignId, relationId, rel[0].account_id, status, RECUS]
  );
  return decorate(rows[0]);
}

/**
 * Change le statut. Passer à « a reçu » horodate la réception si ce n'était
 * pas déjà fait — c'est cette date qui sert à repérer les retards.
 */
async function setParticipantStatus(client, tenantId, participantId, status) {
  if (!isStatus(status)) {
    const err = new Error('statut_inconnu');
    err.code = 'statut_inconnu';
    throw err;
  }
  const { rows } = await client.query(
    `UPDATE campaign_participants
        SET status = $3,
            received_at = CASE WHEN $3 = ANY($4) THEN COALESCE(received_at, now()) ELSE received_at END,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [participantId, tenantId, status, RECUS]
  );
  if (!rows[0]) {
    const err = new Error('participante_introuvable');
    err.code = 'participante_introuvable';
    throw err;
  }
  return decorate(rows[0]);
}

/**
 * « +1 publication ». Le lien du contenu est facultatif mais recommandé :
 * c'est lui qui rend le compte vérifiable plus tard.
 * Publier fait automatiquement passer au statut « a publié ».
 */
async function addPost(client, tenantId, participantId, { url = null, kind = null, at = null, source = 'manuel', addedBy = null } = {}) {
  const post = {
    url: url ? String(url).slice(0, 500) : null,
    kind: kind ? String(kind).slice(0, 30) : null,
    at: at ? new Date(at).toISOString() : new Date().toISOString(),
    source,
    added_by: addedBy || null,
  };
  const { rows } = await client.query(
    `UPDATE campaign_participants
        SET posts = posts || $3::jsonb,
            posts_count = posts_count + 1,
            status = 'a_publie',
            first_post_at = COALESCE(first_post_at, $4::timestamptz),
            last_post_at = GREATEST(COALESCE(last_post_at, $4::timestamptz), $4::timestamptz),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [participantId, tenantId, JSON.stringify([post]), post.at]
  );
  if (!rows[0]) {
    const err = new Error('participante_introuvable');
    err.code = 'participante_introuvable';
    throw err;
  }
  return decorate(rows[0]);
}

/** Retire la dernière publication (faute de frappe, double clic). */
async function removeLastPost(client, tenantId, participantId) {
  const { rows } = await client.query(
    `UPDATE campaign_participants
        SET posts = CASE WHEN jsonb_array_length(posts) > 0
                         THEN posts - (jsonb_array_length(posts) - 1) ELSE posts END,
            posts_count = GREATEST(posts_count - 1, 0),
            status = CASE WHEN posts_count - 1 <= 0 AND status = 'a_publie' THEN 'a_recu' ELSE status END,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [participantId, tenantId]
  );
  if (!rows[0]) {
    const err = new Error('participante_introuvable');
    err.code = 'participante_introuvable';
    throw err;
  }
  return decorate(rows[0]);
}

// ---------------------------------------------------------------------------
// Le bilan par personne — ce qui sert à exclure
// ---------------------------------------------------------------------------

/**
 * Bilan d'une influenceuse pour CETTE marque, toutes campagnes confondues.
 * Lu par l'interface et par l'assistante avant toute recommandation.
 *
 * `verdict` :
 *   'fiable'        — a reçu et a publié ;
 *   'jamais_publie' — a reçu au moins une paire, aucune publication ;
 *   'en_retard'     — a reçu, rien publié, le délai est dépassé ;
 *   'nouvelle'      — n'a encore rien reçu ;
 *   'exclue'        — écartée explicitement par Luc.
 */
async function accountRecord(client, tenantId, relationId) {
  if (!relationId) return null;
  const { rows } = await client.query(
    `SELECT
       COUNT(*)                                            AS participations,
       COUNT(*) FILTER (WHERE p.status = ANY($3))          AS recus,
       COUNT(*) FILTER (WHERE p.status = 'exclue')         AS exclusions,
       COUNT(*) FILTER (WHERE p.status = ANY($3) AND p.posts_count = 0) AS sans_publication,
       COALESCE(SUM(p.posts_count), 0)                     AS publications,
       MAX(p.received_at)                                  AS dernier_envoi,
       MAX(p.last_post_at)                                 AS derniere_publication
     FROM campaign_participants p
     WHERE p.tenant_id = $1 AND p.relation_id = $2`,
    [tenantId, relationId, RECUS]
  );
  const r = rows[0] || {};
  const { rows: gift } = await client.query(
    `SELECT COUNT(*) AS paires FROM gifting_orders
      WHERE tenant_id = $1 AND influence_relation_id = $2 AND status = 'created'`,
    [tenantId, relationId]
  );

  return summarize({ ...r, paires: gift[0] ? gift[0].paires : 0 });
}

/**
 * Même bilan, pour plusieurs relations d'un coup — la liste des profils en
 * affiche jusqu'à 200, une requête par ligne serait absurde.
 * @returns {Promise<Object>} bilan indexé par relation_id
 */
async function recordsForRelations(client, tenantId, relationIds) {
  const ids = (relationIds || []).filter(Boolean);
  if (!ids.length) return {};
  const { rows } = await client.query(
    `WITH part AS (
       SELECT relation_id,
              COUNT(*) AS participations,
              COUNT(*) FILTER (WHERE status = ANY($3)) AS recus,
              COUNT(*) FILTER (WHERE status = 'exclue') AS exclusions,
              COUNT(*) FILTER (WHERE status = ANY($3) AND posts_count = 0) AS sans_publication,
              COALESCE(SUM(posts_count), 0) AS publications,
              MAX(received_at) AS dernier_envoi,
              MAX(last_post_at) AS derniere_publication
         FROM campaign_participants
        WHERE tenant_id = $1 AND relation_id = ANY($2::uuid[])
        GROUP BY relation_id
     ), gift AS (
       SELECT influence_relation_id AS relation_id, COUNT(*) AS paires
         FROM gifting_orders
        WHERE tenant_id = $1 AND influence_relation_id = ANY($2::uuid[]) AND status = 'created'
        GROUP BY influence_relation_id
     )
     SELECT COALESCE(part.relation_id, gift.relation_id) AS relation_id,
            part.participations, part.recus, part.exclusions, part.sans_publication,
            part.publications, part.dernier_envoi, part.derniere_publication, gift.paires
       FROM part FULL OUTER JOIN gift ON gift.relation_id = part.relation_id`,
    [tenantId, ids, RECUS]
  );
  const out = {};
  for (const r of rows) out[r.relation_id] = summarize(r);
  return out;
}

/** Met en forme une ligne agrégée en bilan lisible (logique partagée). */
function summarize(r) {
  const recus = Number(r.recus || 0);
  const publications = Number(r.publications || 0);
  const pairesEnvoyees = Math.max(recus, Number(r.paires || 0));
  const joursDepuisEnvoi = joursDepuis(r.dernier_envoi);
  let verdict = 'nouvelle';
  if (Number(r.exclusions || 0) > 0) verdict = 'exclue';
  else if (pairesEnvoyees === 0) verdict = 'nouvelle';
  else if (publications > 0) verdict = 'fiable';
  else if (joursDepuisEnvoi != null && joursDepuisEnvoi >= DELAI_PUBLICATION_JOURS) verdict = 'jamais_publie';
  else verdict = 'en_retard';
  return {
    participations: Number(r.participations || 0),
    paires_envoyees: pairesEnvoyees,
    publications,
    campagnes_sans_publication: Number(r.sans_publication || 0),
    dernier_envoi: r.dernier_envoi || null,
    derniere_publication: r.derniere_publication || null,
    jours_depuis_envoi: joursDepuisEnvoi,
    verdict,
  };
}

/** Une phrase lisible, pour l'écran comme pour le prompt de l'assistante. */
function describeRecord(record) {
  if (!record || record.paires_envoyees === 0) return 'Aucune paire offerte jusqu\'ici par la marque.';
  const paires = `${record.paires_envoyees} paire${record.paires_envoyees > 1 ? 's' : ''} offerte${record.paires_envoyees > 1 ? 's' : ''}`;
  if (record.verdict === 'exclue') return `${paires}, écartée des campagnes par Luc.`;
  if (record.publications === 0) {
    const depuis = record.jours_depuis_envoi != null ? `, dernier envoi il y a ${record.jours_depuis_envoi} jour${record.jours_depuis_envoi > 1 ? 's' : ''}` : '';
    return record.verdict === 'jamais_publie'
      ? `${paires}, AUCUNE publication en retour${depuis}.`
      : `${paires}, aucune publication pour l'instant${depuis} (délai pas encore écoulé).`;
  }
  return `${paires}, ${record.publications} publication${record.publications > 1 ? 's' : ''} en retour`
    + (record.campagnes_sans_publication > 0 ? `, dont ${record.campagnes_sans_publication} campagne(s) sans retour.` : '.');
}

/**
 * Aide au comptage : mentions de la marque relevées par la synchro Instagram
 * (lib/business-discovery.js) et postérieures à l'envoi. L'API ne voit que le
 * fil, pas les stories : c'est une SUGGESTION à confirmer, jamais un compte.
 */
function suggestPostsFromMentions(account, participant, brandHandles = []) {
  const mentions = Array.isArray(account?.mentioned_accounts) ? account.mentioned_accounts : [];
  if (!mentions.length || !participant?.received_at) return null;
  const cibles = brandHandles.map((h) => String(h || '').toLowerCase().replace(/^@/, '')).filter(Boolean);
  const trouve = mentions.some((m) => cibles.includes(String(m || '').toLowerCase().replace(/^@/, '')));
  if (!trouve) return null;
  return {
    suggestion: true,
    raison: 'La synchronisation Instagram a relevé une mention de la marque dans ses posts.',
    limite: 'Seuls les posts du fil sont visibles par l\'API : une story ne sera jamais détectée.',
  };
}

module.exports = {
  STATUSES, RECUS, DELAI_PUBLICATION_JOURS,
  listCampaigns, createCampaign, listParticipants,
  addParticipant, setParticipantStatus, addPost, removeLastPost,
  accountRecord, recordsForRelations, summarize, describeRecord, suggestPostsFromMentions,
  decorate, isStatus,
};
