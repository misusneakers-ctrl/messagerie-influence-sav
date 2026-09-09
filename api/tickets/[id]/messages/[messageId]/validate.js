// PATCH /api/tickets/:id/messages/:messageId/validate
// Fait passer un brouillon "draft" -> "validated". Seule cette route peut le
// faire ; aucune autre route ne modifie le statut vers "validated". Requiert
// un validateur explicite (validated_by) — c'est la trace de la validation
// humaine exigée par la spec.
const { withTenantHandler, sendJson } = require('../../../../../lib/handler');
const { withTenant } = require('../../../../../lib/db');
const { logAudit } = require('../../../../../lib/audit');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'PATCH') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const { messageId } = req.query;
  const body = req.body || {};
  if (!body.validated_by) {
    sendJson(res, 400, { error: 'validated_by_required' });
    return;
  }

  try {
    const message = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query('SELECT * FROM ticket_messages WHERE id = $1', [messageId]);
      const existing = rows[0];
      if (!existing) {
        const err = new Error('message_not_found');
        err.httpStatus = 404;
        throw err;
      }
      if (existing.direction !== 'outbound' || existing.status !== 'draft') {
        const err = new Error('only_draft_outbound_messages_can_be_validated');
        err.httpStatus = 409;
        throw err;
      }
      const { rows: updated } = await client.query(
        `UPDATE ticket_messages SET status = 'validated', validated_by = $1, validated_at = now()
         WHERE id = $2 RETURNING *`,
        [body.validated_by, messageId]
      );
      await logAudit(client, tenant.id, {
        actor: body.validated_by,
        action: 'draft_validated',
        entityType: 'ticket_message',
        entityId: messageId,
        details: {},
      });
      return updated[0];
    });
    sendJson(res, 200, { message });
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.message });
      return;
    }
    throw err;
  }
});
