// GET  /api/tickets            liste/recherche des tickets de la marque résolue
// POST /api/tickets            création manuelle d'un ticket (ex. email SAV entrant)
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');

const VALID_STATUSES = ['a_traiter', 'en_attente_client', 'en_attente_interne', 'a_valider', 'resolu', 'erreur'];
const VALID_CATEGORIES = ['Influence', 'SAV', 'Partenariat', 'Presse', 'B2B', 'Commande', 'Livraison', 'Retour', 'Paiement', 'Autre'];

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const { status, channel, category, q } = req.query || {};
    const result = await withTenant(tenant.id, async (client) => {
      const conditions = [];
      const params = [];
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (channel) {
        params.push(channel);
        conditions.push(`channel = $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        conditions.push(`(contact_name ILIKE $${params.length} OR contact_handle ILIKE $${params.length} OR contact_email ILIKE $${params.length} OR related_order_number ILIKE $${params.length})`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await client.query(
        `SELECT * FROM tickets ${where} ORDER BY updated_at DESC LIMIT 200`,
        params
      );
      return rows;
    });
    sendJson(res, 200, { tickets: result });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.channel) {
      sendJson(res, 400, { error: 'channel_required' });
      return;
    }
    const category = VALID_CATEGORIES.includes(body.category) ? body.category : 'Autre';
    const status = VALID_STATUSES.includes(body.status) ? body.status : 'a_traiter';

    const ticket = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tickets
           (tenant_id, channel, category, status, contact_name, contact_handle, contact_email,
            related_order_number, external_thread_id, summary, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          tenant.id, body.channel, category, status,
          body.contact_name || null, body.contact_handle || null, body.contact_email || null,
          body.related_order_number || null, body.external_thread_id || null,
          body.summary || null, body.assigned_to || null,
        ]
      );
      const ticketRow = rows[0];
      await logAudit(client, tenant.id, {
        actor: body.actor || 'manual',
        action: 'ticket_created',
        entityType: 'ticket',
        entityId: ticketRow.id,
        details: { channel: body.channel, category },
      });
      return ticketRow;
    });
    sendJson(res, 201, { ticket });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
