// lib/channels/dispatch.js
// Ajout 2026-09-17, demandé par Luc : « on répond par le canal par lequel on a
// été contacté ». Point unique d'envoi d'un message VALIDÉ, utilisé par
// api/tickets/:id/messages/:messageId/send.js et api/tickets/batch-process.js.
//
// Canal de réponse d'un message sortant, dans l'ordre :
//   1. message.channel s'il a été choisi à la création du brouillon ;
//   2. sinon le canal du DERNIER message reçu du contact dans le ticket ;
//   3. sinon le canal du ticket.
// Un ticket peut contenir plusieurs canaux après une fusion (voir
// api/tickets/[id]/merge.js) : l'identifiant Instagram (IGSID) ou le fil
// e-mail est alors cherché aussi sur les conversations fusionnées dedans.
const { decrypt } = require('../crypto');
const instagram = require('./instagram');
const { sendEmailReply } = require('./email');

function channelError(code, httpStatus = 409) {
  const err = new Error(code);
  err.code = code;
  err.httpStatus = httpStatus;
  return err;
}

async function lastInbound(client, tenantId, ticket, channel) {
  const { rows } = await client.query(
    `SELECT id, created_at, COALESCE(channel, $3) AS channel, email_meta
     FROM ticket_messages
     WHERE ticket_id = $1 AND tenant_id = $2 AND direction = 'inbound'
       AND ($4::text IS NULL OR COALESCE(channel, $3) = $4)
     ORDER BY created_at DESC LIMIT 1`,
    [ticket.id, tenantId, ticket.channel, channel || null]
  );
  return rows[0] || null;
}

async function replyChannelFor(client, tenantId, ticket, message) {
  if (message && message.channel) return message.channel;
  const li = await lastInbound(client, tenantId, ticket, null);
  return (li && li.channel) || ticket.channel;
}

// Tickets « porteurs » d'un canal : le ticket lui-même et ceux fusionnés dedans.
async function channelTicket(client, tenantId, ticket, channel) {
  if (ticket.channel === channel && ticket.external_thread_id) return ticket;
  const { rows } = await client.query(
    `SELECT * FROM tickets WHERE tenant_id = $1 AND merged_into_ticket_id = $2 AND channel = $3 AND external_thread_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, ticket.id, channel]
  );
  return rows[0] || (ticket.channel === channel ? ticket : null);
}

/**
 * Vérifie qu'un message peut partir et renvoie la cible de l'envoi, sans rien
 * envoyer. Lève channelError(code) si ce n'est pas possible (fenêtre 24 h,
 * canal non configuré, destinataire inconnu...).
 */
async function resolveReplyTarget(client, tenant, ticket, message) {
  const channel = await replyChannelFor(client, tenant.id, ticket, message);

  if (channel === 'instagram') {
    const igTicket = await channelTicket(client, tenant.id, ticket, 'instagram');
    if (!igTicket || !igTicket.external_thread_id) throw channelError('instagram_recipient_unknown');
    const li = await lastInbound(client, tenant.id, ticket, 'instagram');
    if (!instagram.isWithinResponseWindow(li && li.created_at)) throw channelError('outside_24h_response_window');
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    if (!rows[0]) throw channelError('instagram_not_configured_for_tenant');
    return { channel, instagram: { igsid: igTicket.external_thread_id, cred: rows[0] } };
  }

  if (channel === 'email') {
    const li = await lastInbound(client, tenant.id, ticket, 'email');
    const meta = (li && li.email_meta) || {};
    const emailTicket = await channelTicket(client, tenant.id, ticket, 'email');
    const to = meta.reply_to || meta.from_email || (emailTicket && emailTicket.contact_email) || ticket.contact_email;
    if (!to) throw channelError('email_recipient_missing');
    const { rows } = await client.query(
      `SELECT metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'gmail'`,
      [tenant.id]
    );
    if (!rows[0]) throw channelError('email_not_configured_for_tenant');
    return {
      channel,
      email: {
        to,
        subject: meta.subject || (emailTicket && emailTicket.email_subject) || ticket.email_subject || null,
        threadId: meta.gmail_thread_id || (emailTicket && emailTicket.external_thread_id) || null,
        inReplyTo: meta.message_id_header || null,
        references: meta.references || null,
      },
    };
  }

  throw channelError(`channel_not_implemented:${channel}`, 501);
}

/**
 * Envoie réellement (après resolveReplyTarget). Retourne
 * { channel, externalMessageId, emailMeta? }.
 */
async function sendToTarget(tenant, target, { text, attachments, fromName }) {
  if (target.channel === 'instagram') {
    const accessToken = decrypt(target.instagram.cred.encrypted_value);
    const igBusinessAccountId = target.instagram.cred.metadata?.ig_business_account_id;
    // Meta : texte puis chaque pièce jointe en appels séparés (voir l'historique
    // de ce comportement dans send.js, correctif 2026-09-15).
    let outcome = null;
    if (text) {
      outcome = await instagram.sendDirectMessage({ accessToken, igBusinessAccountId, recipientIgScopedId: target.instagram.igsid, text });
    }
    for (const attachment of attachments || []) {
      outcome = await instagram.sendDirectMessage({ accessToken, igBusinessAccountId, recipientIgScopedId: target.instagram.igsid, attachment });
    }
    if (!outcome) throw channelError('nothing_to_send', 400);
    return { channel: 'instagram', externalMessageId: outcome.externalMessageId };
  }
  if (target.channel === 'email') {
    const sent = await sendEmailReply(tenant, { target: target.email, text, attachments, fromName });
    return { channel: 'email', externalMessageId: sent.externalMessageId, emailMeta: sent.emailMeta };
  }
  throw channelError(`channel_not_implemented:${target.channel}`, 501);
}

module.exports = { resolveReplyTarget, sendToTarget, replyChannelFor, channelError };
