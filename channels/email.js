// lib/channels/email.js
// Ajout 2026-09-17, demandé par Luc : « si un message entre par e-mail, il
// faudra qu'on soit capable de répondre par e-mail — on répond par le canal
// par lequel on a été contacté ».
//
// Envoi d'une réponse e-mail depuis la boîte SAV connectée (compte Hello),
// DANS LE MÊME FIL que l'e-mail du client : en-têtes In-Reply-To/References
// + threadId Gmail + objet « Re: … ». Appelé uniquement par
// lib/channels/dispatch.js, pour un message déjà validé par un humain.
const { getAccessToken, gmailFetch } = require('../gmail/client');

const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

// Encodage RFC 2047 d'un en-tête (objet, nom affiché) s'il contient autre
// chose que de l'ASCII.
function encodeHeader(value) {
  const v = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function formatAddress(name, email) {
  const clean = String(email || '').replace(/[\r\n<>"]/g, '').trim();
  if (!name) return clean;
  const n = String(name).replace(/[\r\n"]/g, '').trim();
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${clean}>` : `${encodeHeader(n)} <${clean}>`;
}

function base64Lines(buf) {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re: votre message';
  return /^(re|réf|ref|tr|fwd?)\s*:/i.test(s) ? s : `Re: ${s}`;
}

function boundary(tag) {
  return `----=_msav_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Construit le message MIME complet (texte + HTML simple + pièces jointes).
 * attachments : [{ filename, contentType, data: Buffer }]
 */
function buildMime({ from, to, cc, subject, inReplyTo, references, text, attachments = [] }) {
  const alt = boundary('alt');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
  const alternative = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(html, 'utf8')),
    `--${alt}--`,
  ].join('\r\n');

  if (!attachments.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, '', alternative, ''].join('\r\n');
  }
  const mixed = boundary('mixed');
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', alternative];
  for (const a of attachments) {
    const name = encodeHeader(a.filename || 'piece-jointe');
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(a.data)
    );
  }
  parts.push(`--${mixed}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', parts.join('\r\n'), ''].join('\r\n');
}

// Pièces jointes de l'appli (URL Vercel Blob) → contenu binaire.
async function loadAttachments(attachments) {
  const out = [];
  let total = 0;
  for (const a of attachments || []) {
    if (!a || !a.url) continue;
    const resp = await fetch(a.url);
    if (!resp.ok) {
      const err = new Error(`attachment_download_failed (${resp.status})`);
      err.code = 'attachment_download_failed';
      throw err;
    }
    const data = Buffer.from(await resp.arrayBuffer());
    total += data.length;
    if (total > MAX_ATTACHMENTS_BYTES) {
      const err = new Error('attachments_too_large');
      err.code = 'attachments_too_large';
      throw err;
    }
    let filename = a.filename || a.name;
    if (!filename) {
      try { filename = decodeURIComponent(new URL(a.url).pathname.split('/').pop()); } catch { filename = 'piece-jointe'; }
    }
    out.push({ filename, contentType: a.mime_type || a.contentType || resp.headers.get('content-type') || 'application/octet-stream', data });
  }
  return out;
}

/**
 * Envoie une réponse e-mail dans le fil du client.
 * target : { to, cc?, subject, threadId?, inReplyTo?, references? }
 * Retourne { externalMessageId, threadId, emailMeta }.
 */
async function sendEmailReply(tenant, { target, text, attachments, fromName }) {
  if (!target || !target.to) {
    const err = new Error('email_recipient_missing');
    err.code = 'email_recipient_missing';
    throw err;
  }
  const { accessToken, mailbox, metadata } = await getAccessToken(tenant);
  if (!String(metadata.scope || '').includes('gmail.send')) {
    const err = new Error('gmail_send_not_allowed');
    err.code = 'gmail_send_not_allowed';
    throw err;
  }
  const files = await loadAttachments(attachments);
  const subject = replySubject(target.subject);
  const references = [target.references, target.inReplyTo].filter(Boolean).join(' ').split(/\s+/).filter((v, i, arr) => v && arr.indexOf(v) === i).slice(-20).join(' ');
  const mime = buildMime({
    from: formatAddress(fromName, mailbox),
    to: target.to,
    cc: target.cc || null,
    subject,
    inReplyTo: target.inReplyTo || null,
    references: references || null,
    text: String(text || ''),
    attachments: files,
  });

  // Envoi « multipart » (jusqu'à 35 Mo) : métadonnées JSON (threadId) + message brut.
  const b = boundary('upload');
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(target.threadId ? { threadId: target.threadId } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf8'),
    Buffer.from(mime, 'utf8'),
    Buffer.from(`\r\n--${b}--`, 'utf8'),
  ]);
  const sent = await gmailFetch(accessToken, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body: payload,
  });

  // Message-ID réel attribué par Gmail (sert d'In-Reply-To aux réponses suivantes).
  let messageIdHeader = null;
  try {
    const meta = await gmailFetch(accessToken, `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
    const h = ((meta.payload && meta.payload.headers) || []).find((x) => String(x.name).toLowerCase() === 'message-id');
    messageIdHeader = h ? h.value : null;
  } catch {
    /* non bloquant */
  }
  return {
    externalMessageId: sent.id,
    threadId: sent.threadId,
    emailMeta: {
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId,
      message_id_header: messageIdHeader,
      in_reply_to: target.inReplyTo || null,
      references: references || null,
      subject,
      from_email: mailbox,
      to: target.to,
      attachments: files.map((f) => ({ filename: f.filename, size: f.data.length })),
    },
  };
}

module.exports = { sendEmailReply, buildMime, replySubject, encodeHeader, formatAddress };
