// lib/channels/email-sync.js
// Ajout 2026-09-17, demandé par Luc : les e-mails reçus sur la boîte SAV
// (compte Hello) deviennent des tickets de la messagerie, comme les DM
// Instagram. Appelé par api/tickets/sync-email.js (bouton « Actualiser »).
//
// Règles :
// - un ticket par FIL Gmail (external_thread_id = threadId, canal 'email') ;
// - à la création d'un ticket, tout le fil est importé (y compris les
//   réponses déjà envoyées depuis Gmail), pour qu'Alice ait le contexte ;
// - un e-mail envoyé depuis la boîte (réponse faite dans Gmail) n'est importé
//   que dans un fil qui est déjà un ticket ;
// - newsletters, notifications automatiques, promotions, réseaux sociaux,
//   réponses automatiques, spam : ignorés (voir isAutomated) — sauf les
//   formulaires de contact (expéditeur automatique + « Répondre à » un client) ;
// - dédoublonnage par identifiant Gmail (external_message_id), sur toute la
//   marque : relancer la synchro ne crée jamais de doublon ;
// - conversation fusionnée par Luc → les nouveaux e-mails vont dans le ticket
//   cible (merged_into_ticket_id) ;
// - strictement en LECTURE côté Gmail : rien n'est marqué lu, déplacé ni
//   supprimé.
const { withTenant } = require('../db');
const { logAudit } = require('../audit');
const { getAccessToken, gmailFetch, header, parseAddress, extractText, listAttachments } = require('../gmail/client');

const FIRST_SYNC_DAYS = 14;
const OVERLAP_SECONDS = 2 * 24 * 3600;
const MAX_IDS = 300;
const THREAD_IMPORT_LIMIT = 25;

const AUTOMATED_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter|bounce[s]?|info-?noreply)([._+-]|@)/i;
const SKIPPED_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

function isAutomated(msg, headers, fromEmail, replyTo) {
  const labels = msg.labelIds || [];
  if (labels.some((l) => SKIPPED_LABELS.includes(l))) {
    // Formulaire de contact (ex. boutique Shopify) : expéditeur « système »
    // mais « Répondre à » = le client → on garde.
    if (!(replyTo && replyTo !== fromEmail && labels.includes('CATEGORY_UPDATES'))) return 'categorie_ou_spam';
  }
  const auto = (header(headers, 'Auto-Submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return 'reponse_automatique';
  const precedence = (header(headers, 'Precedence') || '').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return 'envoi_de_masse';
  if (header(headers, 'X-Autoreply') || header(headers, 'X-Autorespond')) return 'reponse_automatique';
  if (header(headers, 'List-Unsubscribe') || header(headers, 'List-Id')) return 'newsletter';
  if (fromEmail && AUTOMATED_SENDER.test(fromEmail) && !(replyTo && replyTo !== fromEmail)) return 'expediteur_automatique';
  return null;
}

function parseGmailMessage(msg, mailbox) {
  const headers = (msg.payload && msg.payload.headers) || [];
  const from = parseAddress(header(headers, 'From'));
  const replyToAddr = parseAddress(header(headers, 'Reply-To'));
  const replyTo = replyToAddr.email && replyToAddr.email !== from.email ? replyToAddr.email : null;
  const labels = msg.labelIds || [];
  const outbound = labels.includes('SENT') || (!!mailbox && from.email === mailbox);
  const attachments = listAttachments(msg.payload).map((a) => ({ filename: a.filename, mime_type: a.mime_type, size: a.size }));
  let text = extractText(msg.payload);
  if (!text && msg.snippet) text = msg.snippet;
  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: new Date(Number(msg.internalDate) || Date.now()),
    headers,
    labels,
    outbound,
    from,
    replyTo,
    subject: header(headers, 'Subject') || '',
    text,
    attachments,
    emailMeta: {
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      message_id_header: header(headers, 'Message-ID'),
      in_reply_to: header(headers, 'In-Reply-To'),
      references: header(headers, 'References'),
      subject: header(headers, 'Subject') || '',
      from: header(headers, 'From'),
      from_email: from.email,
      reply_to: replyTo,
      to: header(headers, 'To'),
      cc: header(headers, 'Cc'),
      date: header(headers, 'Date'),
      attachments,
    },
  };
}

async function listNewIds(accessToken, query) {
  const ids = [];
  let pageToken = null;
  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('includeSpamTrash', 'false');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await gmailFetch(accessToken, url.toString());
    (page.messages || []).forEach((m) => ids.push(m));
    pageToken = page.nextPageToken || null;
  } while (pageToken && ids.length < MAX_IDS);
  return ids;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

/**
 * Synchronise la boîte e-mail SAV → tickets.
 * Retourne { mailbox, scanned, tickets_created, messages_created, skipped, remaining, errors }.
 */
async function syncEmailInbox(tenant, { maxMessages = 40, timeBudgetMs = 45000 } = {}) {
  const started = Date.now();
  const { accessToken, mailbox, metadata } = await getAccessToken(tenant);
  const lastSync = metadata.last_sync_at ? Math.floor(new Date(metadata.last_sync_at).getTime() / 1000) : null;
  const since = lastSync ? `after:${lastSync - OVERLAP_SECONDS}` : `newer_than:${FIRST_SYNC_DAYS}d`;
  const query = `(in:inbox OR in:sent) ${since}`;
  const syncStartedAt = new Date().toISOString();

  const summary = { mailbox, query, scanned: 0, tickets_created: 0, messages_created: 0, skipped: {}, remaining: 0, errors: [] };
  const listed = await listNewIds(accessToken, query);

  // Déjà importés ?
  const known = await withTenant(tenant.id, async (client) => {
    if (!listed.length) return new Set();
    const { rows } = await client.query(
      `SELECT external_message_id FROM ticket_messages WHERE tenant_id = $1 AND external_message_id = ANY($2::text[])`,
      [tenant.id, listed.map((m) => m.id)]
    );
    return new Set(rows.map((r) => r.external_message_id));
  });
  const fresh = listed.filter((m) => !known.has(m.id));
  // Plus anciens d'abord (Gmail renvoie les plus récents en premier).
  fresh.reverse();
  const batch = fresh.slice(0, maxMessages);
  summary.remaining = fresh.length - batch.length;

  const fetched = await mapLimit(batch, 8, async (m) => {
    try {
      return parseGmailMessage(await gmailFetch(accessToken, `/messages/${m.id}?format=full`), mailbox);
    } catch (err) {
      summary.errors.push({ gmail_message_id: m.id, error: err.message });
      return null;
    }
  });
  const messages = fetched.filter(Boolean).sort((a, b) => a.internalDate - b.internalDate);
  const importedIds = new Set();

  for (const msg of messages) {
    if (Date.now() - started > timeBudgetMs) {
      summary.remaining += messages.length - summary.scanned;
      break;
    }
    summary.scanned += 1;
    if (importedIds.has(msg.id)) continue;
    try {
      const reason = msg.outbound ? null : isAutomated({ labelIds: msg.labels }, msg.headers, msg.from.email, msg.replyTo);
      if (reason) {
        summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
        continue;
      }
      await withTenant(tenant.id, async (client) => {
        const { rows: found } = await client.query(
          `SELECT * FROM tickets WHERE tenant_id = $1 AND channel = 'email' AND external_thread_id = $2`,
          [tenant.id, msg.threadId]
        );
        let ticket = found[0] || null;
        if (ticket && ticket.merged_into_ticket_id) {
          const { rows: target } = await client.query('SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2', [ticket.merged_into_ticket_id, tenant.id]);
          if (target[0]) ticket = target[0];
        }

        let toInsert = [msg];
        if (!ticket) {
          if (msg.outbound) {
            summary.skipped.envoye_hors_ticket = (summary.skipped.envoye_hors_ticket || 0) + 1;
            return;
          }
          const contactEmail = msg.replyTo || msg.from.email;
          const { rows: opt } = await client.query(
            `SELECT field, label FROM ticket_field_options WHERE tenant_id = $1 AND is_default`,
            [tenant.id]
          );
          const category = (opt.find((o) => o.field === 'category') || {}).label || 'Autre';
          const status = (opt.find((o) => o.field === 'status') || {}).label || 'À traiter';
          const { rows: created } = await client.query(
            `INSERT INTO tickets (tenant_id, channel, category, status, contact_name, contact_email, external_thread_id, email_subject, summary)
             VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [tenant.id, category, status, msg.from.name || null, contactEmail, msg.threadId, msg.subject || null, msg.subject ? msg.subject.slice(0, 200) : null]
          );
          ticket = created[0];
          summary.tickets_created += 1;
          await logAudit(client, tenant.id, {
            actor: 'system:email-sync', action: 'ticket_created', entityType: 'ticket', entityId: ticket.id,
            details: { via: 'sync_email', gmail_thread_id: msg.threadId, from: contactEmail },
          });
          // Tout le fil (réponses déjà faites depuis Gmail comprises).
          try {
            const thread = await gmailFetch(accessToken, `/threads/${msg.threadId}?format=full`);
            const all = (thread.messages || []).slice(-THREAD_IMPORT_LIMIT).map((t) => parseGmailMessage(t, mailbox));
            toInsert = all.filter((t) => t.id === msg.id || t.outbound || !isAutomated({ labelIds: t.labels }, t.headers, t.from.email, t.replyTo));
          } catch (err) {
            summary.errors.push({ gmail_thread_id: msg.threadId, error: 'lecture_du_fil: ' + err.message });
          }
        }

        let inserted = 0;
        let latest = null;
        for (const m of toInsert) {
          const { rows: exists } = await client.query(
            `SELECT 1 FROM ticket_messages WHERE tenant_id = $1 AND external_message_id = $2`,
            [tenant.id, m.id]
          );
          importedIds.add(m.id);
          if (exists.length) continue;
          const attNote = m.attachments.length ? `\n[pièce(s) jointe(s) : ${m.attachments.map((a) => a.filename).join(', ')}]` : '';
          await client.query(
            `INSERT INTO ticket_messages (tenant_id, ticket_id, direction, status, body, external_message_id, created_at, attachments, channel, email_meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '[]', 'email', $8)`,
            [tenant.id, ticket.id, m.outbound ? 'outbound' : 'inbound', m.outbound ? 'sent' : 'received',
              (m.text || '(e-mail sans texte)') + attNote, m.id, m.internalDate.toISOString(), JSON.stringify(m.emailMeta)]
          );
          inserted += 1;
          if (!latest || m.internalDate > latest) latest = m.internalDate;
        }
        if (inserted) {
          summary.messages_created += inserted;
          await client.query(
            `UPDATE tickets SET updated_at = GREATEST(updated_at, $1),
               contact_email = COALESCE(contact_email, $2), contact_name = COALESCE(contact_name, $3),
               email_subject = COALESCE(email_subject, $4)
             WHERE id = $5 AND tenant_id = $6`,
            [latest.toISOString(), msg.outbound ? null : (msg.replyTo || msg.from.email), msg.outbound ? null : msg.from.name, msg.subject || null, ticket.id, tenant.id]
          );
        }
      });
    } catch (err) {
      summary.errors.push({ gmail_message_id: msg.id, error: err.message });
    }
  }

  // Curseur : avancé seulement quand tout ce qui était nouveau a été traité.
  if (summary.remaining === 0 && !summary.errors.length) {
    await withTenant(tenant.id, async (client) => {
      await client.query(
        `UPDATE tenant_credentials SET metadata = metadata || jsonb_build_object('last_sync_at', $1::text), updated_at = now()
         WHERE tenant_id = $2 AND type = 'gmail'`,
        [syncStartedAt, tenant.id]
      );
    });
  }
  return summary;
}

module.exports = { syncEmailInbox, isAutomated, parseGmailMessage };
