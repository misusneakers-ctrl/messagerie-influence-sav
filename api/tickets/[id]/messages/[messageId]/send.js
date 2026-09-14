// POST /api/tickets/:id/messages/:messageId/send
// Seule route qui peut faire passer un message "validated" -> "sent".
// Exige : message déjà validé, ticket avec un message entrant dans les
// dernières 24h (canal Instagram), idempotency_key fourni par l'appelant
// pour empêcher un double envoi en cas de retry réseau.
const { withTenantHandler, sendJson } = require('../../../../../lib/handler');
const { withTenant } = require('../../../../../lib/db');
const { logAudit } = require('../../../../../lib/audit');
const { decrypt } = require('../../../../../lib/crypto');
const instagram = require('../../../../../lib/channels/instagram');

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

      if (ticket.channel === 'instagram') {
        const { rows: lastInboundRows } = await client.query(
          `SELECT created_at FROM ticket_messages
           WHERE ticket_id = $1 AND tenant_id = $2 AND direction = 'inbound'
           ORDER BY created_at DESC LIMIT 1`,
          [ticketId, tenant.id]
        );
        const lastInboundAt = lastInboundRows[0]?.created_at;
        if (!instagram.isWithinResponseWindow(lastInboundAt)) {
          const err = new Error('outside_24h_response_window');
          err.httpStatus = 409;
          throw err;
        }

        const { rows: credRows } = await client.query(
          `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
          [tenant.id]
        );
        const cred = credRows[0];
        if (!cred) {
          const err = new Error('instagram_not_configured_for_tenant');
          err.httpStatus = 409;
          throw err;
        }
        const accessToken = decrypt(cred.encrypted_value);
        const igBusinessAccountId = cred.metadata?.ig_business_account_id;

        let sendOutcome;
        try {
          sendOutcome = await instagram.sendDirectMessage({
            accessToken,
            igBusinessAccountId,
            recipientIgScopedId: ticket.external_thread_id,
            text: message.body,
          });
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
            details: { error: sendErr.message },
          });
          const err = new Error('send_failed');
          err.httpStatus = 502;
          err.cause = sendErr.message;
          throw err;
        }

        const { rows: sentRows } = await client.query(
          `UPDATE ticket_messages
           SET status = 'sent', sent_at = now(), external_message_id = $1, idempotency_key = $2
           WHERE id = $3 AND tenant_id = $4 RETURNING *`,
          [sendOutcome.externalMessageId, body.idempotency_key, messageId, tenant.id]
        );
        await logAudit(client, tenant.id, {
          actor: body.approved_by,
          action: 'message_sent',
          entityType: 'ticket_message',
          entityId: messageId,
          details: { external_message_id: sendOutcome.externalMessageId },
        });
        return { message: sentRows[0], alreadyProcessed: false };
      }

      // Autres canaux (email) : à brancher au moment où le canal email est câblé.
      const err = new Error(`channel_not_implemented:${ticket.channel}`);
      err.httpStatus = 501;
      throw err;
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
