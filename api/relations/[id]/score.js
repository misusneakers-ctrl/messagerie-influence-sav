// PATCH /api/relations/[id]/score
// Correctif 2026-09-15 (7e passage), demandé par Luc ("pour avoir une note
// un peu plus quali ?? qu'est-ce qu'on peut faire ? même en dehors de cette
// plateforme ? Juste pour relier la donnée") : jusqu'ici, le score affiché
// dans le panneau influence était TOUJOURS à 0/100 pour tout le monde, parce
// qu'aucun endpoint ni aucun écran ne permettait de saisir les 6 sous-notes
// qui le composent (tenant_influence_relations.score_*, voir
// PLAN-ARCHITECTURE-Messagerie-Influence-SAV.md section 2.1) — seuls les
// champs d'IDENTITÉ du profil (influence_accounts, via
// api/profiles/[id].js) étaient éditables. Ce endpoint comble ce manque :
// il édite les sous-notes de la RELATION (propres à ce tenant, pas
// partagées entre marques comme l'identité).
//
// Pourquoi 6 notes séparées et pas UNE seule "note qualité" : c'est le
// modèle déjà cadré avec Luc dans SPEC-Messagerie-Influence-SAV.md — un
// score explicable, plafonné par sous-critère, jamais une boîte noire.
// C'est aussi la réponse à "relier des données EXTERNES à la plateforme" :
// engagement observable et audience pertinente peuvent maintenant être
// informés par une vérification faite ailleurs (ex. le lien "Vérifier fake
// followers" déjà ajouté au panneau, ou Social Blade, etc.) — Luc regarde le
// résultat sur le site externe, puis reporte la note ici à la main, avec la
// preuve dans les notes. Contrainte dure du cahier des charges, rappelée
// ici : "le score ne repose jamais sur des données sensibles, supposées ou
// non vérifiables. Chaque note doit être justifiable par une preuve ou une
// observation" — d'où le champ evidence_notes à côté.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');
const { logAudit } = require('../../../lib/audit');

const SCORE_FIELDS = {
  score_brand_fit: 25,
  score_content_quality: 20,
  score_engagement: 20,
  score_audience_relevance: 15,
  score_reliability: 10,
  score_commercial_potential: 10,
};

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

  const body = req.body || {};
  const setClauses = [];
  const params = [id, tenant.id];

  for (const [field, max] of Object.entries(SCORE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    if (raw === null) {
      params.push(null);
      setClauses.push(`${field} = $${params.length}`);
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      sendJson(res, 400, { error: 'invalid_score', field, message: `${field} doit être un entier entre 0 et ${max}.` });
      return;
    }
    params.push(value);
    setClauses.push(`${field} = $${params.length}`);
  }
  // next_action / owner / relationship_status : pas des notes, mais
  // logiquement à côté (mêmes champs "relation propre au tenant") — pratique
  // de pouvoir les poser en même temps que la note depuis le même écran.
  for (const field of ['relationship_status', 'next_action', 'owner']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      params.push(body[field] || null);
      setClauses.push(`${field} = $${params.length}`);
    }
  }

  if (setClauses.length === 0) {
    sendJson(res, 400, { error: 'no_editable_fields_provided', allowed: [...Object.keys(SCORE_FIELDS), 'relationship_status', 'next_action', 'owner'] });
    return;
  }

  try {
    const relation = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `UPDATE tenant_influence_relations SET ${setClauses.join(', ')}, updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        params
      );
      return rows[0] || null;
    });
    if (!relation) {
      sendJson(res, 404, { error: 'relation_not_found_for_tenant' });
      return;
    }
    await withTenant(tenant.id, async (client) => {
      await logAudit(client, tenant.id, {
        actor: body.actor || 'manual',
        action: 'influence_relation_scored',
        entityType: 'tenant_influence_relation',
        entityId: relation.id,
        details: { fields: Object.keys(body), score_total: relation.score_total },
      });
    });
    sendJson(res, 200, { relation });
  } catch (err) {
    sendJson(res, 400, { error: 'update_failed', detail: err.message });
  }
});
