// PATCH /api/profiles/[id]   met à jour les champs éditables d'un profil
//                             influence (influence_accounts.id) — correctif
//                             2026-09-15, panneau "qualité influenceuse"
//                             demandé par Luc.
//
// influence_accounts est une identité PARTAGÉE entre marques (modèle
// "agence" — voir api/profiles/index.js) : cette route n'est donc PAS
// filtrée par tenant_id (il n'y en a pas sur cette table), mais elle exige
// tout de même un tenant valide (withTenantHandler) pour qu'on ne puisse
// pas l'appeler sans être authentifié sur une marque, et elle vérifie que
// ce tenant a bien une relation avec ce compte avant d'accepter la
// modification — sinon n'importe quel tenant pourrait éditer le profil
// d'un influenceur connu d'une autre marque uniquement.
//
// Champs éditables : ceux que l'API Instagram ne peut pas fournir
// automatiquement (email, âge — jamais exposés par Meta pour un compte
// tiers — et le lien vers une story sauvegardée, les stories d'un autre
// compte n'étant pas lisibles via l'API), plus les champs qui SERONT
// alimentés automatiquement une fois la Business Discovery API branchée
// (photo de profil, followers, engagement, tags fréquents) mais qui restent
// éditables à la main en attendant.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant, withoutTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');

const EDITABLE_FIELDS = [
  'display_name',
  'instagram_handle',
  'tiktok_handle',
  'instagram_url',
  'tiktok_url',
  'email',
  'age',
  'city',
  'country',
  'follower_count',
  'engagement_observed',
  'profile_picture_url',
  'saved_story_url',
  'frequent_tags',
  'editorial_universe',
  'visible_brands_collabs',
  'evidence_notes',
];

module.exports = withTenantHandler(async (req, res, tenant) => {
  const { id } = req.query || {};
  if (!id) {
    sendJson(res, 400, { error: 'id_required' });
    return;
  }

  if (req.method !== 'PATCH') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  // Vérifie que ce tenant a bien une relation avec ce compte avant
  // d'autoriser la modification (voir note de sécurité en tête de fichier).
  const hasRelation = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM tenant_influence_relations WHERE tenant_id = $1 AND account_id = $2`,
      [tenant.id, id]
    );
    return rows.length > 0;
  });
  if (!hasRelation) {
    sendJson(res, 404, { error: 'profile_not_found_for_tenant' });
    return;
  }

  const body = req.body || {};
  const setClauses = [];
  const params = [id];
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      params.push(field === 'frequent_tags' ? (Array.isArray(body[field]) ? body[field] : null) : body[field]);
      setClauses.push(`${field} = $${params.length}`);
    }
  }
  if (setClauses.length === 0) {
    sendJson(res, 400, { error: 'no_editable_fields_provided', allowed: EDITABLE_FIELDS });
    return;
  }

  try {
    const account = await withoutTenant(async (client) => {
      const { rows } = await client.query(
        `UPDATE influence_accounts SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        params
      );
      return rows[0] || null;
    });
    if (!account) {
      sendJson(res, 404, { error: 'profile_not_found' });
      return;
    }
    await withTenant(tenant.id, async (client) => {
      await logAudit(client, tenant.id, {
        actor: body.actor || 'manual',
        action: 'influence_profile_updated',
        entityType: 'influence_account',
        entityId: account.id,
        details: { fields: Object.keys(body).filter((f) => EDITABLE_FIELDS.includes(f)) },
      });
    });
    sendJson(res, 200, { account });
  } catch (err) {
    sendJson(res, 400, { error: 'update_failed', detail: err.message });
  }
});
