// lib/channels/email-sync.js
// Ajout 2026-09-17, demandé par Luc : les e-mails reçus sur la boîte SAV
// (compte Hello) deviennent des tickets de la messagerie, comme les DM
// Instagram. Appelé par api/tickets/sync-email.js (bouton « Actualiser »).
//
// Règles :
// - un ticket par FIL Gmail ET PAR CORRESPONDANT (correctif 2026-09-17, voir
//   plus bas) ;
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

// ---------------------------------------------------------------------------
// Correctif 2026-09-17 — « un ticket par fil » ne suffit pas
// ---------------------------------------------------------------------------
// Constaté sur BBP : deux clientes différentes (Margaux Déchanet et
// Anne-Laure M'Ba) répondent chacune au MÊME e-mail marketing (« Votre
// première commande BB »). Gmail les range dans un seul fil (même
// References/Subject), donc les deux demandes atterrissaient dans un seul
// ticket — Alice mélangeait les deux dossiers, et une réponse a été rédigée
// au nom de la mauvaise cliente.
//
// Désormais la clé d'un ticket e-mail est « fil + correspondant » :
//   external_thread_id = "<threadId>|<email du client>"
// Les tickets déjà créés avec la clé « <threadId> » seule continuent d'être
// reconnus (voir findThreadTickets / pickTicketForMessage) : aucune migration
// de base n'est nécessaire.
const THREAD_SEP = '|';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function lower(v) {
  return String(v || '').trim().toLowerCase();
}

function threadKey(threadId, contactEmail) {
  return `${threadId}${THREAD_SEP}${lower(contactEmail)}`;
}

// Interlocuteur d'un message REÇU : « Répondre à » s'il diffère, sinon
// l'expéditeur.
function correspondentOf(msg) {
  return lower(msg.replyTo || (msg.from && msg.from.email));
}

// Destinataires d'un message ENVOYÉ depuis la boîte SAV, la boîte elle-même
// exclue : sert à savoir à quelle cliente rattacher la réponse.
function recipientsOf(msg, mailbox) {
  const raw = `${header(msg.headers, 'To') || ''} ${header(msg.headers, 'Cc') || ''}`;
  const all = (raw.match(EMAIL_RE) || []).map(lower);
  const box = lower(mailbox);
  return Array.from(new Set(all.filter((e) => e && e !== box)));
}

async function findThreadTickets(client, tenantId, threadId) {
  const { rows } = await client.query(
    `SELECT * FROM tickets
      WHERE tenant_id = $1 AND channel = 'email'
        AND (external_thread_id = $2 OR external_thread_id LIKE $2 || '${THREAD_SEP}%')
      ORDER BY created_at ASC`,
    [tenantId, threadId]
  );
  return rows;
}

// Quel ticket du fil reçoit ce message ?
function pickTicketForMessage(rows, msg, mailbox) {
  if (!rows.length) return null;
  if (!msg.outbound) {
    const contact = correspondentOf(msg);
    const exact = rows.find((r) => lower(r.contact_email) === contact);
    if (exact) return exact;
    // Ticket créé avant le correctif (clé = threadId seul) et encore sans
    // contact identifié : on le réutilise plutôt que d'en créer un second.
    return rows.find((r) => !r.contact_email && r.external_thread_id === msg.threadId) || null;
  }
  const rcpts = recipientsOf(msg, mailbox);
  const match = rows.find((r) => r.contact_email && rcpts.includes(lower(r.contact_email)));
  if (match) return match;
  // Réponse envoyée depuis Gmail sans destinataire reconnu : rattachée
  // seulement s'il n'y a aucune ambiguïté (un seul ticket sur ce fil).
  return rows.length === 1 ? rows[0] : null;
}

const FIRST_SYNC_DAYS = 14;
const OVERLAP_SECONDS = 2 * 24 * 3600;
const MAX_IDS = 300;
const THREAD_IMPORT_LIMIT = 25;

const AUTOMATED_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter|bounce[s]?|info-?noreply)([._+-]|@)/i;
const SKIPPED_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

// Correctif 2026-09-17 : les notifications PayPal (« Notification de paiement
// reçu ») passaient par l'exception « formulaire de contact », parce qu'elles
// portent un « Répondre à » = adresse de l'acheteuse. Résultat : 54 e-mails
// d'acheteuses différentes empilés dans un seul ticket.
// Ces plateformes de paiement / envoi ne produisent jamais une vraie demande
// client : on les écarte quel que soit le « Répondre à ».
const NOTIFICATION_DOMAINS = [
  'paypal.fr', 'paypal.com', 'paypal.co.uk', 'stripe.com', 'klarna.com', 'getalma.eu', 'alma.eu',
  'scalapay.com', 'klaviyo.com', 'klaviyomail.com', 'mailchimp.com', 'sendgrid.net', 'shopifyemail.com',
];
// …et l'exception « formulaire de contact » ne vaut plus que pour un
// expéditeur de formulaire reconnu : la boutique elle-même (même domaine que
// la boîte SAV) ou Shopify.
const FORM_DOMAINS = ['shopify.com', 'myshopify.com'];

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
}

function isNotificationSender(fromEmail) {
  const d = domainOf(fromEmail);
  return !!d && NOTIFICATION_DOMAINS.some((n) => d === n || d.endsWith('.' + n));
}

function isContactFormSender(fromEmail, mailbox) {
  const d = domainOf(fromEmail);
  if (!d) return false;
  const own = domainOf(mailbox);
  if (own && (d === own || d.endsWith('.' + own))) return true;
  return FORM_DOMAINS.some((f) => d === f || d.endsWith('.' + f));
}

function isAutomated(msg, headers, fromEmail, replyTo, mailbox) {
  const labels = msg.labelIds || [];
  if (isNotificationSender(fromEmail)) return 'notification_plateforme';
  if (labels.some((l) => SKIPPED_LABELS.includes(l))) {
    // Formulaire de contact (ex. boutique Shopify) : expéditeur « système »
    // mais « Répondre à » = le client → on garde.
    const contactForm = replyTo && replyTo !== fromEmail
      && labels.includes('CATEGORY_UPDATES')
      && isContactFormSender(fromEmail, mailbox);
    if (!contactForm) return 'categorie_ou_spam';
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
      const reason = msg.outbound ? null : isAutomated({ labelIds: msg.labels }, msg.headers, msg.from.email, msg.replyTo, mailbox);
      if (reason) {
        summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
        continue;
      }
      await withTenant(tenant.id, async (client) => {
        // Insère un lot de messages dans un ticket donné, met à jour la fiche.
        const insertInto = async (ticket, list, contactHint) => {
          let inserted = 0;
          let latest = null;
          for (const m of list) {
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
          if (!inserted) return;
          summary.messages_created += inserted;
          const firstInbound = list.find((m) => !m.outbound);
          await client.query(
            `UPDATE tickets SET updated_at = GREATEST(updated_at, $1),
               contact_email = COALESCE(contact_email, $2), contact_name = COALESCE(contact_name, $3),
               email_subject = COALESCE(email_subject, $4)
             WHERE id = $5 AND tenant_id = $6`,
            [latest.toISOString(),
              (contactHint && contactHint.email) || (firstInbound ? correspondentOf(firstInbound) : null),
              (contactHint && contactHint.name) || (firstInbound && firstInbound.from ? firstInbound.from.name : null),
              (firstInbound || list[0]).subject || null, ticket.id, tenant.id]
          );
        };

        const followMerge = async (ticket) => {
          if (!ticket || !ticket.merged_into_ticket_id) return ticket;
          const { rows: target } = await client.query('SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2', [ticket.merged_into_ticket_id, tenant.id]);
          return target[0] || ticket;
        };

        const threadTickets = await findThreadTickets(client, tenant.id, msg.threadId);
        let ticket = await followMerge(pickTicketForMessage(threadTickets, msg, mailbox));

        if (ticket) {
          await insertInto(ticket, [msg], null);
          return;
        }
        if (msg.outbound) {
          summary.skipped.envoye_hors_ticket = (summary.skipped.envoye_hors_ticket || 0) + 1;
          return;
        }

        // Création. On lit tout le fil et on le DÉCOUPE PAR CORRESPONDANT :
        // chaque cliente qui a répondu au même e-mail obtient son propre
        // ticket, avec ses messages et les réponses qui lui étaient adressées.
        let threadMsgs = [msg];
        try {
          const thread = await gmailFetch(accessToken, `/threads/${msg.threadId}?format=full`);
          const all = (thread.messages || []).slice(-THREAD_IMPORT_LIMIT).map((t) => parseGmailMessage(t, mailbox));
          if (all.length) threadMsgs = all;
        } catch (err) {
          summary.errors.push({ gmail_thread_id: msg.threadId, error: 'lecture_du_fil: ' + err.message });
        }

        const groups = new Map(); // email du client -> { name, messages: [] }
        const ensureGroup = (email, name) => {
          if (!email) return null;
          if (!groups.has(email)) groups.set(email, { email, name: name || null, messages: [] });
          const g = groups.get(email);
          if (!g.name && name) g.name = name;
          return g;
        };
        for (const t of threadMsgs) {
          if (t.outbound) continue;
          if (t.id !== msg.id && isAutomated({ labelIds: t.labels }, t.headers, t.from.email, t.replyTo, mailbox)) continue;
          const g = ensureGroup(correspondentOf(t), t.from && t.from.name);
          if (g) g.messages.push(t);
        }
        // Le message déclencheur doit toujours avoir son groupe.
        ensureGroup(correspondentOf(msg), msg.from && msg.from.name);
        if (!groups.get(correspondentOf(msg)).messages.some((m) => m.id === msg.id)) {
          groups.get(correspondentOf(msg)).messages.push(msg);
        }
        // Les réponses envoyées depuis la boîte rejoignent la cliente à qui
        // elles étaient adressées ; si le fil n'a qu'une cliente, tout lui va.
        for (const t of threadMsgs) {
          if (!t.outbound) continue;
          const rcpts = recipientsOf(t, mailbox);
          const target = rcpts.find((r) => groups.has(r));
          if (target) groups.get(target).messages.push(t);
          else if (groups.size === 1) Array.from(groups.values())[0].messages.push(t);
        }

        const { rows: opt } = await client.query(
          `SELECT field, label FROM ticket_field_options WHERE tenant_id = $1 AND is_default`,
          [tenant.id]
        );
        const category = (opt.find((o) => o.field === 'category') || {}).label || 'Autre';
        const status = (opt.find((o) => o.field === 'status') || {}).label || 'À traiter';

        for (const group of groups.values()) {
          group.messages.sort((a, b) => a.internalDate - b.internalDate);
          const existing = await followMerge(
            threadTickets.find((r) => lower(r.contact_email) === group.email) || null
          );
          let target = existing;
          if (!target) {
            const firstInbound = group.messages.find((m) => !m.outbound) || group.messages[0];
            const { rows: created } = await client.query(
              `INSERT INTO tickets (tenant_id, channel, category, status, contact_name, contact_email, external_thread_id, email_subject, summary)
               VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
              [tenant.id, category, status, group.name || null, group.email,
                threadKey(msg.threadId, group.email), firstInbound.subject || null,
                firstInbound.subject ? firstInbound.subject.slice(0, 200) : null]
            );
            target = created[0];
            summary.tickets_created += 1;
            await logAudit(client, tenant.id, {
              actor: 'system:email-sync', action: 'ticket_created', entityType: 'ticket', entityId: target.id,
              details: {
                via: 'sync_email',
                gmail_thread_id: msg.threadId,
                from: group.email,
                correspondants_du_fil: groups.size,
              },
            });
          }
          await insertInto(target, group.messages, group);
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

module.exports = { syncEmailInbox, isAutomated, parseGmailMessage, threadKey, correspondentOf, recipientsOf, isNotificationSender };
