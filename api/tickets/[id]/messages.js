// GET  /api/tickets/:id/messages   historique complet du fil
// POST /api/tickets/:id/messages   ajoute un message :
//        - direction "inbound"  : message reçu (webhook canal, ou saisie manuelle email SAV)
//        - direction "outbound" : crée TOUJOURS un brouillon (status "draft"),
//          jamais un envoi direct — l'envoi passe par
//          /api/tickets/:id/messages/:messageId/send après validation.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');
const { logAudit } = require('../../../lib/audit');

module.exports = withTenantHandler(async (req, res, tenant) => {
  const ticketId = req.query.id;

  if (req.method === 'GET') {
    const messages = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
        [ticketId]
      );
      return rows;
    });
    sendJson(res, 200, { messages });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.direction || !['inbound', 'outbound'].includes(body.direction)) {
      sendJson(res, 400, { error: 'direction_must_be_inbound_or_outbound' });
      return;
    }
    if (!body.body) {
      sendJson(res, 400, { error: 'body_required' });
      return;
    }

    try {
      const message = await withTenant(tenant.id, async (client) => {
        const { rows: ticketRows } = await client.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
        const ticket = ticketRows[0];
        if (!ticket) {
          const err = new Error('ticket_not_found');
          err.httpStatus = 404;
          throw err;
        }

        if (body.direction === 'outbound') {
          // Garde-fou anti premier-contact-non-sollicité : un message sortant
          // ne peut exister que sur un ticket qui a déjà reçu au moins un
          // message entrant. Un ticket créé manuellement pour du SAV (email)
          // sans message entrant explicite doit d'abord recevoir un message
          // "inbound" représentant la demande initiale.
          const { rows: inboundRows } = await client.query(
            `SELECT 1 FROM ticket_messages WHERE ticket_id = $1 AND direction = 'inbound' LIMIT 1`,
            [ticketId]
          );
          if (inboundRows.length === 0) {
            const err = new Error('no_inbound_interaction_yet');
            err.httpStatus = 409;
            throw err;
          }
        }

        const status = body.direction === 'inbound' ? 'received' : 'draft';
        const { rows } = await client.query(
          `INSERT INTO ticket_messages (tenant_id, ticket_id, direction, body, status, external_message_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING *`,
          [tenant.id, ticketId, body.direction, body.body, status, body.external_message_id || null]
        );
        const messageRow = rows[0];

        await logAudit(client, tenant.id, {
          actor: body.actor || 'system',
          action: body.direction === 'inbound' ? 'message_received' : 'draft_created',
          entityType: 'ticket_message',
          entityId: messageRow.id,
          details: { ticket_id: ticketId },
        });

        return messageRow;
      });
      sendJson(res, 201, { message });
    } catch (err) {
      if (err.httpStatus) {
        sendJson(res, err.httpStatus, { error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
