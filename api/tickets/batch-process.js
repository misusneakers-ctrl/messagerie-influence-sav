// POST /api/tickets/batch-process
// Traite en lot une sélection de brouillons cochés depuis la vue "File de
// validation" : édition optionnelle du texte, puis draft -> validated -> sent,
// un message à la fois, CHACUN DANS SA PROPRE TRANSACTION pour qu'une erreur
// sur un ticket ne bloque jamais le traitement des autres.
//
// Ce n'est pas un raccourci qui contourne les garde-fous existants : chaque
// item repasse par exactement les mêmes règles que les routes individuelles
// /messages/:messageId/validate et /send (fenêtre 24h Instagram, idempotency
// key, journal d'audit). Cocher une case côté front = validation humaine
// explicite de CE texte précis (voir SPEC-Messagerie-Influence-SAV.md,
// section "1 bis").
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { decrypt } = require('../../lib/crypto');
const instagram = require('../../lib/channels/instagram');

async function processOne(tenant, item, approvedBy) {
  const messageId = item.message_id;
  const ticketId = item.ticket_id;
  const idempotencyKey = item.idempotency_key || `batch-${messageId}`;

  return withTenant(tenant.id, async (client) => {
    // Idempotence : si cette clé a déjà servi (retry réseau, double-clic), ne
    // pas retenter un envoi, renvoyer l'état déjà connu.
    const { rows: existingByKey } = await client.query(
      `SELECT * FROM ticket_messages WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.id, idempotencyKey]
    );
    if (existingByKey.length > 0) {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'sent', already_processed: true };
    }

    const { rows: msgRows } = await client.query(
      'SELECT * FROM ticket_messages WHERE id = $1 AND ticket_id = $2',
      [messageId, ticketId]
    );
    const message = msgRows[0];
    if (!message) {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'error', reason: 'message_not_found' };
    }
    if (message.direction !== 'outbound' || message.status !== 'draft') {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'error', reason: 'not_a_pending_draft' };
    }

    // Édition en ligne éventuelle : le texte envoyé est toujours celui
    // affiché au moment du clic sur "Traiter la sélection", jamais une
    // version antérieure du brouillon.
    let finalBody = message.body;
    if (typeof item.body === 'string' && item.body.trim() && item.body !== message.body) {
      finalBody = item.body;
      await client.query(`UPDATE ticket_messages SET body = $1 WHERE id = $2`, [finalBody, messageId]);
      await logAudit(client, tenant.id, {
        actor: approvedBy,
        action: 'draft_edited',
        entityType: 'ticket_message',
        entityId: messageId,
        details: { via: 'batch_process' },
      });
    }

    const { rows: ticketRows } = await client.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    const ticket = ticketRows[0];
    if (!ticket) {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'error', reason: 'ticket_not_found' };
    }

    if (ticket.channel !== 'instagram') {
      // Email SAV pas encore câblé (voir TRANSMISSION) : jamais envoyable
      // depuis ce lot, on l'exclut proprement plutôt que d'échouer.
      return { message_id: messageId, ticket_id: ticketId, outcome: 'excluded', reason: `channel_not_implemented:${ticket.channel}` };
    }

    const { rows: lastInboundRows } = await client.query(
      `SELECT created_at FROM ticket_messages
       WHERE ticket_id = $1 AND direction = 'inbound'
       ORDER BY created_at DESC LIMIT 1`,
      [ticketId]
    );
    const lastInboundAt = lastInboundRows[0]?.created_at;
    if (!instagram.isWithinResponseWindow(lastInboundAt)) {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'excluded', reason: 'outside_24h_response_window' };
    }

    // Validation (draft -> validated) : tracée exactement comme si Luc avait
    // cliqué "Valider" sur ce ticket précis, un par un.
    await client.query(
      `UPDATE ticket_messages SET status = 'validated', validated_by = $1, validated_at = now() WHERE id = $2`,
      [approvedBy, messageId]
    );
    await logAudit(client, tenant.id, {
      actor: approvedBy,
      action: 'draft_validated',
      entityType: 'ticket_message',
      entityId: messageId,
      details: { via: 'batch_process' },
    });

    const { rows: credRows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    const cred = credRows[0];
    if (!cred) {
      return { message_id: messageId, ticket_id: ticketId, outcome: 'error', reason: 'instagram_not_configured_for_tenant' };
    }
    const accessToken = decrypt(cred.encrypted_value);
    const igBusinessAccountId = cred.metadata?.ig_business_account_id;

    let sendOutcome;
    try {
      sendOutcome = await instagram.sendDirectMessage({
        accessToken,
        igBusinessAccountId,
        recipientIgScopedId: ticket.external_thread_id,
        text: finalBody,
      });
    } catch (sendErr) {
      await client.query(
        `UPDATE ticket_messages SET status = 'rejected', error = $1, idempotency_key = $2 WHERE id = $3`,
        [sendErr.message, idempotencyKey, messageId]
      );
      await logAudit(client, tenant.id, {
        actor: approvedBy,
        action: 'send_failed',
        entityType: 'ticket_message',
        entityId: messageId,
        details: { error: sendErr.message, via: 'batch_process' },
      });
      return { message_id: messageId, ticket_id: ticketId, outcome: 'error', reason: sendErr.message };
    }

    await client.query(
      `UPDATE ticket_messages
       SET status = 'sent', sent_at = now(), external_message_id = $1, idempotency_key = $2
       WHERE id = $3`,
      [sendOutcome.externalMessageId, idempotencyKey, messageId]
    );
    await logAudit(client, tenant.id, {
      actor: approvedBy,
      action: 'message_sent',
      entityType: 'ticket_message',
      entityId: messageId,
      details: { external_message_id: sendOutcome.externalMessageId, via: 'batch_process' },
    });

    return { message_id: messageId, ticket_id: ticketId, outcome: 'sent' };
  });
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!body.approved_by) {
    sendJson(res, 400, { error: 'approved_by_required' });
    return;
  }
  if (items.length === 0) {
    sendJson(res, 400, { error: 'items_required' });
    return;
  }
  if (items.length > 100) {
    sendJson(res, 400, { error: 'too_many_items', max: 100 });
    return;
  }

  const results = [];
  // Traitement séquentiel, jamais en parallèle : un échec reste isolé à son
  // propre ticket (chaque item a sa propre transaction) et le journal
  // d'audit garde un ordre lisible.
  for (const item of items) {
    if (!item || !item.message_id || !item.ticket_id) {
      results.push({ message_id: item && item.message_id, ticket_id: item && item.ticket_id, outcome: 'error', reason: 'invalid_item' });
      continue;
    }
    try {
      const result = await processOne(tenant, item, body.approved_by);
      results.push(result);
    } catch (err) {
      console.error('batch-process item error', err);
      results.push({ message_id: item.message_id, ticket_id: item.ticket_id, outcome: 'error', reason: 'internal_error' });
    }
  }

  const summary = {
    sent: results.filter((r) => r.outcome === 'sent').length,
    errors: results.filter((r) => r.outcome === 'error'),
    excluded: results.filter((r) => r.outcome === 'excluded'),
  };

  sendJson(res, 200, { results, summary });
});
