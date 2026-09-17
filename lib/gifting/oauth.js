// lib/gifting/oauth.js
// Ajout 2026-09-16 (commande gifting) : connexion OAuth Shopify de l'app
// dédiée aux commandes de gifting, faite UNE fois par Luc depuis l'appli
// (bouton « 🔗 Connecter Shopify »), sans jamais manipuler de token à la main
// ni passer par un endpoint temporaire à secret unique (mécanisme qui a fui
// 3 fois, voir TRANSMISSION-Messagerie-Influence-SAV.md).
//
// Configuration requise sur Vercel (une paire par marque, jamais dans le code) :
//   SHOPIFY_GIFTING_CLIENT_ID_BBP / SHOPIFY_GIFTING_CLIENT_SECRET_BBP
//   SHOPIFY_GIFTING_CLIENT_ID_MISU / SHOPIFY_GIFTING_CLIENT_SECRET_MISU
// Côté Shopify Dev Dashboard, l'app doit déclarer l'URL de redirection
// REDIRECT_URI ci-dessous et les scopes SCOPES.
const crypto = require('crypto');

const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/gifting/shopify-callback';
const SCOPES = 'write_draft_orders,read_orders';
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function appCredentials(slug) {
  const key = String(slug || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const clientId = process.env[`SHOPIFY_GIFTING_CLIENT_ID_${key}`];
  const clientSecret = process.env[`SHOPIFY_GIFTING_CLIENT_SECRET_${key}`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signState(slug, secret) {
  const payload = b64url(JSON.stringify({ s: slug, t: Date.now(), n: crypto.randomBytes(12).toString('hex') }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function readStateSlug(state) {
  try {
    const [payload] = String(state || '').split('.');
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return data.s || null;
  } catch {
    return null;
  }
}

function verifyState(state, secret) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return false;
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Date.now() - Number(data.t) < STATE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

// Vérification de la signature HMAC ajoutée par Shopify à la redirection.
function verifyShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(String(hmac));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(shop || ''));
}

module.exports = { REDIRECT_URI, SCOPES, appCredentials, signState, readStateSlug, verifyState, verifyShopifyHmac, isValidShopDomain };
