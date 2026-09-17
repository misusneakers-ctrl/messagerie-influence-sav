// lib/gmail/client.js
// Ajout 2026-09-17 (enquête d'Alice), demandé par Luc : Alice peut chercher
// dans la boîte e-mail SAV de la marque (lecture seule) pour retrouver une
// commande ou l'historique d'un client.
//
// - Droit demandé à Google : gmail.readonly UNIQUEMENT (aucun envoi, aucune
//   suppression, aucune modification possible avec ce jeton).
// - Connexion faite UNE fois par Luc depuis l'appli (« ✨ Assistante IA » →
//   « 📧 Connecter Gmail »), via le flux OAuth Google standard. Le jeton de
//   rafraîchissement est stocké CHIFFRÉ dans tenant_credentials (type
//   'gmail_readonly'), jamais affiché ni journalisé.
// - Configuration Vercel (une seule app Google pour les deux marques) :
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
const { withTenant } = require('../db');
const { decrypt } = require('../crypto');

const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/gmail/callback';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function googleAppCredentials() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function loadGmailCredential(tenant) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'gmail_readonly'`,
      [tenant.id]
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
  return { accessToken: json.access_token, mailbox: cred.metadata && cred.metadata.email };
}

function b64urlDecode(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body && payload.body.data) return payload.body.data;
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

// Texte lisible d'un e-mail, sans l'historique cité (« Le … a écrit : », « > »).
function extractText(payload) {
  let text = '';
  const plain = findPart(payload, 'text/plain');
  if (plain) {
    text = b64urlDecode(plain);
  } else {
    const html = findPart(payload, 'text/html');
    if (html) {
      text = b64urlDecode(html)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/&quot;/g, '"');
    }
  }
  const lines = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(Le|On) .{5,120}(a écrit|wrote)\s*:\s*$/i.test(line)) break;
    if (/^-{2,}\s*(Original Message|Message d'origine)/i.test(line)) break;
    lines.push(line.trim());
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

module.exports = { REDIRECT_URI, SCOPE, googleAppCredentials, searchEmails, loadGmailCredential, extractText };
