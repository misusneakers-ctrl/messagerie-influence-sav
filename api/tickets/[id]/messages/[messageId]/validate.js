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
  // Correctif sécurité 2026-09-14 — le plus grave des trous trouvés dans
  // l'audit du 12/09 : cette route ne filtrait NI par tenant_id NI par
  // ticketId (req.query.id n'était même pas lu), et RLS ne compense rien
  // (rôle applicatif en BYPASSRLS). Résultat avant correctif : connaître un
  // messageId (UUID) suffisait à valider un brouillon appartenant à
  // n'importe quel tenant, sur n'importe quel ticket, sans aucune
  // vérification de cohérence avec l'URL appelée. Les deux identifiants de
  // l'URL sont maintenant exigés et vérifiés.
  const { id: ticketId, messageId } = req.query;
  const body = req.body || {};
  if (!body.validated_by) {
    sendJson(res, 400, { error: 'validated_by_required' });
    return;
  }

  try {
    const message = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM ticket_messages WHERE id = $1 AND ticket_id = $2 AND tenant_id = $3',
        [messageId, ticketId, tenant.id]
      );
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
         WHERE id = $2 AND ticket_id = $3 AND tenant_id = $4 RETURNING *`,
        [body.validated_by, messageId, ticketId, tenant.id]
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
