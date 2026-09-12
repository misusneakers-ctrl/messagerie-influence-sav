// POST /api/tickets/sync-instagram
// Sondage manuel des DM Instagram côté Meta (bouton "Actualiser Instagram"
// dans l'appli ; une tâche planifiée pourra appeler ce même endpoint plus
// tard sans rien changer côté front). Fait apparaître les nouveaux messages
// entrants comme tickets/messages dans le noyau. STRICTEMENT en lecture côté
// Instagram : ne répond jamais, ne crée jamais de brouillon, n'appelle aucune
// fonction d'envoi. Phase B du connecteur direct (lecture seule d'abord),
// voir PLAN-ARCHITECTURE-Messagerie-Influence-SAV.md section 3 et 5.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');
const instagramRead = require('../../lib/channels/instagram-read');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const cred = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    return rows[0] || null;
  });
  if (!cred) {
    sendJson(res, 400, { error: 'instagram_not_configured_for_tenant' });
    return;
  }

  let accessToken;
  try {
    accessToken = decrypt(cred.encrypted_value);
  } catch (err) {
    sendJson(res, 400, { error: 'decrypt_failed' });
    return;
  }

  const igBusinessAccountId = cred.metadata && cred.metadata.ig_business_account_id;
  if (!igBusinessAccountId) {
    sendJson(res, 400, { error: 'ig_business_account_id_missing' });
    return;
  }

  let conversations;
  try {
    conversations = await instagramRead.listConversations({ accessToken, igBusinessAccountId });
  } catch (err) {
    sendJson(res, 502, { error: 'instagram_api_error', detail: err.message });
    return;
  }

  const summary = {
    conversations_scanned: conversations.length,
    tickets_created: 0,
    messages_created: 0,
    errors: [],
  };

  for (const conversation of conversations) {
    try {
      const participants = (conversation.participants && conversation.participants.data) || [];
      const contactParticipant = participants.find((p) => p.id !== igBusinessAccountId);
      if (!contactParticipant) continue; // pas d'interlocuteur identifiable, on ignore

      const messages = await instagramRead.getConversationMessages({
        accessToken,
        conversationId: conversation.id,
      });
      if (messages.length === 0) continue;

      await withTenant(tenant.id, async (client) => {
        // Un ticket par interlocuteur Instagram — external_thread_id = IGSID
        // du contact, le même identifiant que celui utilisé pour l'envoi
        // (voir lib/channels/instagram.js, sendDirectMessage).
        const { rows: existingTicketRows } = await client.query(
          `SELECT * FROM tickets WHERE tenant_id = $1 AND channel = 'instagram' AND external_thread_id = $2`,
          [tenant.id, contactParticipant.id]
        );
        let ticket = existingTicketRows[0];

        if (!ticket) {
          const [{ rows: defaultCategoryRows }, { rows: defaultStatusRows }] = await Promise.all([
            client.query(
              `SELECT label FROM ticket_field_options WHERE tenant_id = $1 AND field = 'category' AND is_default LIMIT 1`,
              [tenant.id]
            ),
            client.query(
              `SELECT label FROM ticket_field_options WHERE tenant_id = $1 AND field = 'status' AND is_default LIMIT 1`,
              [tenant.id]
            ),
          ]);
          // Tout entrant Instagram par défaut en catégorie "Influence" (canal
          // principal d'approche, voir PLAN-ARCHITECTURE section 3.2) —
          // reclassable ensuite à la main comme n'importe quel ticket.
          const category = (defaultCategoryRows[0] && defaultCategoryRows[0].label) || 'Influence';
          const status = (defaultStatusRows[0] && defaultStatusRows[0].label) || 'a_traiter';

          const { rows: insertedTicketRows } = await client.query(
            `INSERT INTO tickets (tenant_id, channel, category, status, contact_handle, external_thread_id)
             VALUES ($1, 'instagram', $2, $3, $4, $5) RETURNING *`,
            [tenant.id, category, status, contactParticipant.username || null, contactParticipant.id]
          );
          ticket = insertedTicketRows[0];
          summary.tickets_created += 1;
          await logAudit(client, tenant.id, {
            actor: 'system:instagram-sync',
            action: 'ticket_created',
            entityType: 'ticket',
            entityId: ticket.id,
            details: { via: 'sync_instagram', external_thread_id: contactParticipant.id },
          });
        }

        for (const message of messages) {
          const { rows: existingMsgRows } = await client.query(
            `SELECT id FROM ticket_messages WHERE tenant_id = $1 AND external_message_id = $2`,
            [tenant.id, message.id]
          );
          if (existingMsgRows.length > 0) continue; // déjà importé, sondage idempotent

          const isFromBusiness = message.from && message.from.id === igBusinessAccountId;
          const direction = isFromBusiness ? 'outbound' : 'inbound';
          // Exception assumée au workflow draft -> validated -> sent : un
          // message sortant vu ici a déjà été envoyé ailleurs (ex. réponse
          // manuelle depuis Meta Business Suite), on l'importe pour
          // l'historique du fil, jamais comme un nouveau brouillon à valider.
          const status = isFromBusiness ? 'sent' : 'received';

          await client.query(
            `INSERT INTO ticket_messages (tenant_id, ticket_id, direction, status, body, external_message_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              tenant.id,
              ticket.id,
              direction,
              status,
              message.message || '',
              message.id,
              message.created_time || new Date().toISOString(),
            ]
          );
          summary.messages_created += 1;
        }

        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticket.id]);
      });
    } catch (err) {
      summary.errors.push({ conversation_id: conversation.id, error: err.message });
    }
  }

  sendJson(res, 200, summary);
});
