// GET    /api/tickets/:id
// PATCH  /api/tickets/:id            (accepte aussi { archived: true|false })
// DELETE /api/tickets/:id            suppression définitive (ticket + messages)
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
      // tenant_id filtré explicitement : voir le même correctif dans
      // api/tickets/index.js (RLS ne protège pas ces requêtes, rôle
      // applicatif en BYPASSRLS).
      const { rows } = await client.query(
        'SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2',
        [ticketId, tenant.id]
      );
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
          // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté. Sans
          // lui, un ticket pouvait être re-catégorisé avec une valeur qui
          // n'existe QUE chez l'autre marque (même défaut que celui corrigé
          // le 12/09 sur api/settings/options/index.js).
          const { rows } = await client.query(
            "SELECT 1 FROM ticket_field_options WHERE tenant_id = $1 AND field = 'category' AND label = $2",
            [tenant.id, body.category]
          );
          if (rows.length === 0) {
            const err = new Error('invalid_category');
            err.httpStatus = 400;
            throw err;
          }
        }
        if (body.status !== undefined) {
          const { rows } = await client.query(
            "SELECT 1 FROM ticket_field_options WHERE tenant_id = $1 AND field = 'status' AND label = $2",
            [tenant.id, body.status]
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
        // Archivage / désarchivage réversible — { archived: true } masque le
        // ticket de la boîte par défaut sans rien supprimer ; { archived:
        // false } le restaure.
        if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
          if (body.archived) {
            updates.push(`archived_at = now()`);
          } else {
            updates.push(`archived_at = NULL`);
          }
        }
        if (updates.length === 0) {
          const err = new Error('no_fields_to_update');
          err.httpStatus = 400;
          throw err;
        }

        params.push(ticketId, tenant.id);
        const { rows } = await client.query(
          `UPDATE tickets SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
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
          action: Object.prototype.hasOwnProperty.call(body, 'archived')
            ? (body.archived ? 'ticket_archived' : 'ticket_unarchived')
            : 'ticket_updated',
          entityType: 'ticket',
          entityId: ticketRow.id,
          details: { fields: Object.keys(body).filter((k) => PATCHABLE_FIELDS.includes(k) || k === 'archived') },
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

  if (req.method === 'DELETE') {
    try {
      const deleted = await withTenant(tenant.id, async (client) => {
        const { rows: existingRows } = await client.query(
          'SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2',
          [ticketId, tenant.id]
        );
        const ticketRow = existingRows[0];
        if (!ticketRow) {
          const err = new Error('ticket_not_found');
          err.httpStatus = 404;
          throw err;
        }
        // Log AVANT suppression effective (l'entité n'existera plus après).
        await logAudit(client, tenant.id, {
          actor: (req.body && req.body.actor) || 'manual',
          action: 'ticket_deleted',
          entityType: 'ticket',
          entityId: ticketRow.id,
          details: {
            channel: ticketRow.channel,
            contact_handle: ticketRow.contact_handle,
            contact_email: ticketRow.contact_email,
            external_thread_id: ticketRow.external_thread_id,
          },
        });
        await client.query(
          'DELETE FROM ticket_messages WHERE ticket_id = $1 AND tenant_id = $2',
          [ticketId, tenant.id]
        );
        await client.query('DELETE FROM tickets WHERE id = $1 AND tenant_id = $2', [ticketId, tenant.id]);
        return true;
      });
      if (!deleted) {
        sendJson(res, 404, { error: 'ticket_not_found' });
        return;
      }
      sendJson(res, 200, { deleted: true });
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
