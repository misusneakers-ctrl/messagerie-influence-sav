// GET   /api/tickets/:id
// PATCH /api/tickets/:id
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');
const { logAudit } = require('../../../lib/audit');

const PATCHABLE_FIELDS = [
  'category',
  'status',
  'assigned_to',
  'summary',
  'influence_relation_id',
  'related_order_number',
  'contact_name',
  'contact_handle',
  'contact_email',
];

module.exports = withTenantHandler(async (req, res, tenant) => {
  const ticketId = req.query.id;

  if (req.method === 'GET') {
    const ticket = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
      return rows[0] || null;
    });
    if (!ticket) {
      sendJson(res, 404, { error: 'ticket_not_found' });
      return;
    }
    sendJson(res, 200, { ticket });
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};

    try {
      const ticket = await withTenant(tenant.id, async (client) => {
        if (body.category !== undefined) {
          const { rows } = await client.query(
            "SELECT 1 FROM ticket_field_options WHERE field = 'category' AND label = $1",
            [body.category]
          );
          if (rows.length === 0) {
            const err = new Error('invalid_category');
            err.httpStatus = 400;
            throw err;
          }
        }
        if (body.status !== undefined) {
          const { rows } = await client.query(
            "SELECT 1 FROM ticket_field_options WHERE field = 'status' AND label = $1",
            [body.status]
          );
          if (rows.length === 0) {
            const err = new Error('invalid_status');
            err.httpStatus = 400;
            throw err;
          }
        }

        const updates = [];
        const params = [];
        for (const field of PATCHABLE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            params.push(body[field] === '' ? null : body[field]);
            updates.push(`${field} = $${params.length}`);
          }
        }
        if (updates.length === 0) {
          const err = new Error('no_fields_to_update');
          err.httpStatus = 400;
          throw err;
        }

        params.push(ticketId);
        const { rows } = await client.query(
          `UPDATE tickets SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
          params
        );
        const ticketRow = rows[0];
        if (!ticketRow) {
          const err = new Error('ticket_not_found');
          err.httpStatus = 404;
          throw err;
        }
        await logAudit(client, tenant.id, {
          actor: body.actor || 'manual',
          action: 'ticket_updated',
          entityType: 'ticket',
          entityId: ticketRow.id,
          details: { fields: Object.keys(body).filter((k) => PATCHABLE_FIELDS.includes(k)) },
        });
        return ticketRow;
      });
      sendJson(res, 200, { ticket });
    } catch (err) {
      if (err.httpStatus) {
        sendJson(res, err.httpStatus, { error: err.message });
        return;
      }
      if (err.code === '23503') {
        sendJson(res, 400, { error: 'invalid_reference', detail: err.detail });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
