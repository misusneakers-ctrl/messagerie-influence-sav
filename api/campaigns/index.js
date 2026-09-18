// GET  /api/campaigns          → liste des campagnes de la marque, avec le bilan
// POST /api/campaigns          → crée une campagne nommée
// GET  /api/campaigns?id=<id>  → participantes d'une campagne
//
// Ajout 2026-09-18, demandé par Luc : suivre qui participe à une campagne,
// qui a reçu sa paire et qui a publié — « surtout pour l'exclusion des
// filles qui ne posteraient pas ».
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { listCampaigns, createCampaign, listParticipants } = require('../../lib/campaigns');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const campaignId = req.query && req.query.id;
    const data = await withTenant(tenant.id, async (client) => (
      campaignId
        ? { participants: await listParticipants(client, tenant.id, String(campaignId)) }
        : { campaigns: await listCampaigns(client, tenant.id) }
    ));
    sendJson(res, 200, data);
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    try {
      const campaign = await withTenant(tenant.id, async (client) => {
        const created = await createCampaign(client, tenant.id, body);
        await logAudit(client, tenant.id, {
          actor: body.created_by || 'luc',
          action: 'campaign_created',
          entityType: 'campaign',
          entityId: created.id,
          details: { name: created.name },
        });
        return created;
      });
      sendJson(res, 201, { campaign });
    } catch (err) {
      if (err.code === 'name_required') {
        sendJson(res, 400, { error: 'name_required', message: 'Donne un nom à la campagne (ex. « FW26 Elisabeth »).' });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
