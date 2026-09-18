// POST  /api/campaigns/participants   → ajoute une influenceuse à une campagne
// PATCH /api/campaigns/participants   → change son statut, ou +1 / −1 publication
//
// Ajout 2026-09-18. Le comptage des publications est MANUEL et assumé comme
// tel : c'est Luc qui voit la story ou le reel et qui clique. L'API Instagram
// ne voit que les posts du fil — elle ne peut que suggérer (voir
// suggestPostsFromMentions dans lib/campaigns.js), jamais compter à sa place.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const {
  addParticipant, setParticipantStatus, addPost, removeLastPost, STATUSES,
} = require('../../lib/campaigns');

const ERREURS = {
  relation_introuvable: [404, 'Cette influenceuse n\'est pas rattachée à cette marque.'],
  participante_introuvable: [404, 'Participation introuvable.'],
  statut_inconnu: [400, `Statut inconnu. Attendu : ${STATUSES.join(', ')}.`],
};

function echec(res, err) {
  const known = ERREURS[err.code];
  if (!known) throw err;
  sendJson(res, known[0], { error: err.code, message: known[1] });
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  const body = req.body || {};
  const actor = body.updated_by || body.created_by || 'luc';

  if (req.method === 'POST') {
    if (!body.campaign_id || !body.relation_id) {
      sendJson(res, 400, { error: 'campaign_id_and_relation_id_required' });
      return;
    }
    try {
      const participant = await withTenant(tenant.id, async (client) => {
        const p = await addParticipant(client, tenant.id, {
          campaignId: body.campaign_id, relationId: body.relation_id, status: body.status || 'pressentie',
        });
        await logAudit(client, tenant.id, {
          actor, action: 'campaign_participant_added', entityType: 'campaign_participant', entityId: p.id,
          details: { campaign_id: body.campaign_id, relation_id: body.relation_id, status: p.status },
        });
        return p;
      });
      sendJson(res, 201, { participant });
    } catch (err) { echec(res, err); }
    return;
  }

  if (req.method === 'PATCH') {
    if (!body.id) {
      sendJson(res, 400, { error: 'id_required' });
      return;
    }
    try {
      const participant = await withTenant(tenant.id, async (client) => {
        let p;
        let action;
        if (body.action === 'add_post') {
          p = await addPost(client, tenant.id, body.id, {
            url: body.url, kind: body.kind, at: body.at, source: 'manuel', addedBy: actor,
          });
          action = 'campaign_post_added';
        } else if (body.action === 'remove_post') {
          p = await removeLastPost(client, tenant.id, body.id);
          action = 'campaign_post_removed';
        } else {
          p = await setParticipantStatus(client, tenant.id, body.id, body.status);
          action = 'campaign_participant_status';
        }
        await logAudit(client, tenant.id, {
          actor, action, entityType: 'campaign_participant', entityId: p.id,
          details: { status: p.status, posts_count: p.posts_count, url: body.url || null },
        });
        return p;
      });
      sendJson(res, 200, { participant });
    } catch (err) { echec(res, err); }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
