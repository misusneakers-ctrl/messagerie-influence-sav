// lib/gmail/client.js
// Ajout 2026-09-17, demandé par Luc : la boîte e-mail SAV de la marque (compte
// Google « Hello ») est branchée sur la messagerie :
// - Alice y cherche pour enquêter (commande, historique d'un client) ;
// - les e-mails reçus deviennent des tickets (lib/channels/email-sync.js) ;
// - on répond PAR E-MAIL dans le même fil (lib/channels/email.js), toujours
//   après validation d'un humain — l'IA n'envoie jamais rien.
//
// - Droits demandés à Google : gmail.readonly (lire) + gmail.send (envoyer).
//   Aucune suppression ni modification de la boîte n'est possible avec ce
//   jeton. L'envoi n'est appelé que par api/tickets/:id/messages/:id/send.js
//   et api/tickets/batch-process.js, sur un message validé.
// - Connexion faite UNE fois depuis l'appli (« ✨ Assistante IA » →
//   « 📧 Connecter la boîte e-mail SAV »), en se connectant avec le compte
//   Hello. Le jeton de rafraîchissement est stocké CHIFFRÉ dans
//   tenant_credentials (type 'gmail'), jamais affiché ni journalisé.
// - Configuration Vercel (une seule app Google pour les deux marques) :
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
const { withTenant } = require('../db');
const { decrypt } = require('../crypto');

const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/gmail/callback';
const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = [SCOPE_READ, SCOPE_SEND];
const CREDENTIAL_TYPE = 'gmail';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function googleAppCredentials() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function loadGmailCredential(tenant) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = $2`,
      [tenant.id, CREDENTIAL_TYPE]
    );
    return rows[0] || null;
  });
}

async function getAccessToken(tenant) {
  const app = googleAppCredentials();
  if (!app) {
    const err = new Error('gmail_app_not_configured');
    err.code = 'gmail_app_not_configured';
    throw err;
  }
  const cred = await loadGmailCredential(tenant);
  if (!cred) {
    const err = new Error('gmail_not_connected');
    err.code = 'gmail_not_connected';
    throw err;
  }
  const stored = JSON.parse(decrypt(cred.encrypted_value));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    const err = new Error(`gmail_token_refresh_failed (${json.error || resp.status})`);
    err.code = 'gmail_token_refresh_failed';
    throw err;
  }
  return { accessToken: json.access_token, mailbox: cred.metadata && cred.metadata.email, metadata: cred.metadata || {} };
}

async function gmailFetch(accessToken, path, opts = {}) {
  const resp = await fetch(path.startsWith('https://') ? path : `${GMAIL_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`gmail_http_${resp.status}${json.error && json.error.message ? ' ' + json.error.message : ''}`);
    err.code = 'gmail_api_error';
    err.status = resp.status;
    throw err;
  }
  return json;
}

// « Marion Dupont <marion@ex.fr> » → { name: 'Marion Dupont', email: 'marion@ex.fr' }
function parseAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  const e = raw.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
  return { name: null, email: e ? e[0].toLowerCase() : null };
}

function b64urlDecode(data, charset) {
  const buf = Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return buf.toString('utf8');
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

function partCharset(part) {
  const ct = header(part && part.headers, 'Content-Type') || '';
  const m = ct.match(/charset="?([^";\s]+)"?/i);
  return m ? m[1] : 'utf-8';
}

// Première partie du type demandé (hors pièces jointes) : { data, charset }.
function findPart(payload, mimeType) {
  if (!payload) return null;
  const isAttachment = payload.filename && payload.filename.length > 0;
  if (payload.mimeType === mimeType && payload.body && payload.body.data && !isAttachment) {
    return { data: payload.body.data, charset: partCharset(payload) };
  }
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

// Noms des pièces jointes d'un e-mail (non téléchargées).
function listAttachments(payload, out = []) {
  if (!payload) return out;
  if (payload.filename) out.push({ filename: payload.filename, mime_type: payload.mimeType, size: payload.body && payload.body.size, attachment_id: payload.body && payload.body.attachmentId });
  (payload.parts || []).forEach((p) => listAttachments(p, out));
  return out;
}

const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', euml: 'ë', laquo: '«', raquo: '»', hellip: '…', euro: '€', Eacute: 'É' };
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : m));
}

// Texte lisible d'un e-mail, sans l'historique cité (« Le … a écrit : », « > »).
function extractText(payload) {
  let text = '';
  const plain = findPart(payload, 'text/plain');
  if (plain) {
    text = b64urlDecode(plain.data, plain.charset);
  } else {
    const html = findPart(payload, 'text/html');
    if (html) {
      text = decodeEntities(b64urlDecode(html.data, html.charset)
        .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '));
    }
  }
  const lines = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(Le|On) .{5,160}(a écrit|wrote)\s*:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(Original Message|Message d'origine|Forwarded message|Message transféré)/i.test(line)) break;
    if (/^\s*(De|From)\s*:.+/.test(line) && lines.length > 0 && /^\s*$/.test(lines[lines.length - 1] || '')) break;
    lines.push(line.replace(/[ \t\u00a0]+/g, ' ').trim());
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function header(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/**
 * Recherche Gmail (syntaxe de la barre de recherche Gmail : from:, to:,
 * subject:, after:2026/08/01, "C294902"...). Lecture seule.
 */
async function searchEmails(tenant, { query, maxResults = 8 }) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { error: 'requete_vide' };
  const { accessToken, mailbox } = await getAccessToken(tenant);
  const auth = { Authorization: `Bearer ${accessToken}` };

  const listUrl = new URL(`${GMAIL_API}/messages`);
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('maxResults', String(Math.min(Math.max(maxResults, 1), 10)));
  const listResp = await fetch(listUrl, { headers: auth });
  const list = await listResp.json().catch(() => ({}));
  if (!listResp.ok) {
    const err = new Error(`gmail_search_failed (${listResp.status})`);
    err.code = 'gmail_search_failed';
    throw err;
  }
  const ids = (list.messages || []).map((m) => m.id);
  const messages = await Promise.all(ids.map(async (id) => {
    const resp = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: auth });
    const m = await resp.json().catch(() => null);
    if (!resp.ok || !m) return null;
    const headers = m.payload && m.payload.headers;
    return {
      email_id: m.id,
      thread_id: m.threadId,
      date: header(headers, 'Date'),
      de: header(headers, 'From'),
      a: header(headers, 'To'),
      sujet: header(headers, 'Subject'),
      extrait: extractText(m.payload).slice(0, 1500) || m.snippet || '',
    };
  }));
  return {
    boite: mailbox || null,
    requete: q,
    total_estime: list.resultSizeEstimate || ids.length,
    emails: messages.filter(Boolean),
  };
}

module.exports = {
  REDIRECT_URI, SCOPES, SCOPE_READ, SCOPE_SEND, CREDENTIAL_TYPE, GMAIL_API,
  googleAppCredentials, getAccessToken, gmailFetch, searchEmails, loadGmailCredential,
  extractText, header, parseAddress, findPart, b64urlDecode, listAttachments,
};
