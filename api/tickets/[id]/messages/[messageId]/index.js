// DELETE /api/tickets/:id/messages/:messageId
// Ajout 2026-09-17, demandé par Luc : « dans les brouillons que fait
// l'assistante IA, il faudra pouvoir les supprimer aussi ».
//
// « Mise à la corbeille » d'un brouillon sortant : le message passe en
// status 'rejected'. Il disparaît donc de la file de validation
// (api/tickets/queue.js ne remonte que les 'draft') et du fil côté interface,
// mais la ligne reste en base — on garde la trace de ce qu'Alice / Louise
// avait proposé, et rien n'est effacé pour de bon.
//
// Garde-fous : jamais sur un message entrant, jamais sur un message déjà
// envoyé ('sent'), et filtre tenant_id explicite sur chaque requête (RLS
// décoratif dans cette appli, rôle applicatif en BYPASSRLS).
const { withTenantHandler, sendJson } = require('../../../../../lib/handler');
const { withTenant } = require('../../../../../lib/db');
const { logAudit } = require('../../../../../lib/audit');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const { id: ticketId, messageId } = req.query;

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
      if (existing.direction !== 'outbound') {
        const err = new Error('only_outbound_messages_can_be_deleted');
        err.httpStatus = 409;
        throw err;
      }
      if (existing.status === 'sent') {
        const err = new Error('sent_messages_cannot_be_deleted');
        err.httpStatus = 409;
        throw err;
      }
      if (existing.status === 'rejected') {
        // Déjà à la corbeille : rien à faire, on renvoie l'état courant
        // (idempotent — un double clic ne doit pas produire d'erreur).
        return existing;
      }

      const { rows: updated } = await client.query(
        `UPDATE ticket_messages
            SET status = 'rejected'
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [messageId, tenant.id]
      );

      await logAudit(client, tenant.id, {
        actor: (req.body && req.body.actor) || 'luc',
        action: 'draft_rejected',
        entityType: 'ticket_message',
        entityId: messageId,
        details: {
          ticket_id: ticketId,
          previous_status: existing.status,
          ai_generated: existing.ai_generated === true,
        },
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
