// POST /api/tickets/:id/messages/:messageId/send
// Seule route qui peut faire passer un message "validated" -> "sent".
// Exige : message déjà validé, canal de réponse joignable (Instagram : message entrant
// dans les 24 h ; e-mail : boîte SAV connectée), idempotency_key fourni par l'appelant
// pour empêcher un double envoi en cas de retry réseau.
const { withTenantHandler, sendJson } = require('../../../../../lib/handler');
const { withTenant } = require('../../../../../lib/db');
const { logAudit } = require('../../../../../lib/audit');
const { resolveReplyTarget, sendToTarget } = require('../../../../../lib/channels/dispatch');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const { id: ticketId, messageId } = req.query;
  const body = req.body || {};
  if (!body.idempotency_key) {
    sendJson(res, 400, { error: 'idempotency_key_required' });
    return;
  }
  if (!body.approved_by) {
    sendJson(res, 400, { error: 'approved_by_required' });
    return;
  }

  try {
    const result = await withTenant(tenant.id, async (client) => {
      // Idempotence : si cette clé a déjà été utilisée sur ce tenant, renvoyer
      // le message déjà envoyé plutôt que de retenter un envoi.
      const { rows: existingByKey } = await client.query(
        `SELECT * FROM ticket_messages WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenant.id, body.idempotency_key]
      );
      if (existingByKey.length > 0) {
        return { message: existingByKey[0], alreadyProcessed: true };
      }

      // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté sur les deux
      // requêtes suivantes (message et ticket). Sans lui, un messageId/
      // ticketId d'une AUTRE marque pouvait être accepté (RLS ne protège
      // pas ces requêtes — voir TRANSMISSION-Messagerie-Influence-SAV.md).
      const { rows: msgRows } = await client.query(
        'SELECT * FROM ticket_messages WHERE id = $1 AND ticket_id = $2 AND tenant_id = $3',
        [messageId, ticketId, tenant.id]
      );
      const message = msgRows[0];
      if (!message) {
        const err = new Error('message_not_found');
        err.httpStatus = 404;
        throw err;
      }
      if (message.direction !== 'outbound' || message.status !== 'validated') {
        const err = new Error('only_validated_outbound_messages_can_be_sent');
        err.httpStatus = 409;
        throw err;
      }

      const { rows: ticketRows } = await client.query(
        'SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2',
        [ticketId, tenant.id]
      );
      const ticket = ticketRows[0];
      if (!ticket) {
        const err = new Error('ticket_not_found');
        err.httpStatus = 404;
        throw err;
      }

      // Correctif 2026-09-17 (canal e-mail) : l'envoi passe par
      // lib/channels/dispatch.js, qui répond par le canal du dernier message
      // reçu (Instagram ou e-mail) — voir ce fichier. Le comportement
      // Instagram est inchangé (fenêtre 24 h, texte puis pièces jointes).
      let target;
      try {
        target = await resolveReplyTarget(client, tenant, ticket, message);
      } catch (resolveErr) {
        const err = new Error(resolveErr.code || resolveErr.message);
        err.httpStatus = resolveErr.httpStatus || 409;
        throw err;
      }

      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      let sendOutcome = null;
      try {
        sendOutcome = await sendToTarget(tenant, target, { text: message.body, attachments, fromName: tenant.name });
      } catch (sendErr) {
        await client.query(
          `UPDATE ticket_messages SET status = 'rejected', error = $1, idempotency_key = $2 WHERE id = $3 AND tenant_id = $4`,
          [sendErr.message, body.idempotency_key, messageId, tenant.id]
        );
        await logAudit(client, tenant.id, {
          actor: body.approved_by,
          action: 'send_failed',
          entityType: 'ticket_message',
          entityId: messageId,
          details: { error: sendErr.message, channel: target.channel },
        });
        const err = new Error('send_failed');
        err.httpStatus = 502;
        err.cause = sendErr.message;
        throw err;
      }

      const { rows: sentRows } = await client.query(
        `UPDATE ticket_messages
         SET status = 'sent', sent_at = now(), external_message_id = $1, idempotency_key = $2,
             channel = $5, email_meta = COALESCE($6, email_meta)
         WHERE id = $3 AND tenant_id = $4 RETURNING *`,
        [sendOutcome.externalMessageId, body.idempotency_key, messageId, tenant.id, sendOutcome.channel,
          sendOutcome.emailMeta ? JSON.stringify(sendOutcome.emailMeta) : null]
      );
      await logAudit(client, tenant.id, {
        actor: body.approved_by,
        action: 'message_sent',
        entityType: 'ticket_message',
        entityId: messageId,
        details: { external_message_id: sendOutcome.externalMessageId, channel: sendOutcome.channel },
      });
      return { message: sentRows[0], alreadyProcessed: false };
    });

    sendJson(res, result.alreadyProcessed ? 200 : 201, { message: result.message, already_processed: result.alreadyProcessed });
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.message, details: err.cause });
      return;
    }
    throw err;
  }
});
