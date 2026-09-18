// lib/shopify/readonly-oauth.js
// Ajout 2026-09-17 : reconnexion OAuth de l'app Shopify de LECTURE
// (`bbp-sav-readonly` / `misu-sav-readonly`), sur le même modèle que la
// connexion gifting (lib/gifting/oauth.js) — un bouton, aucun jeton manipulé
// à la main, et surtout AUCUN endpoint temporaire à secret unique (mécanisme
// qui a fui 3 fois, voir TRANSMISSION-Messagerie-Influence-SAV.md).
//
// Pourquoi : le jeton posé le 11/09 n'a que le droit `read_orders`, donc
// l'API Shopify ne montre que les commandes des 60 derniers jours. Alice ne
// retrouvait pas la commande C290707 (20 juin). Le droit `read_all_orders` a
// été ajouté à l'app le 17/09, mais un jeton garde les droits qu'il avait à
// sa création : il faut refaire la connexion pour en obtenir un nouveau.
//
// Configuration requise sur Vercel (une paire par marque, jamais dans le code) :
//   SHOPIFY_READONLY_CLIENT_ID_BBP / SHOPIFY_READONLY_CLIENT_SECRET_BBP
//   SHOPIFY_READONLY_CLIENT_ID_MISU / SHOPIFY_READONLY_CLIENT_SECRET_MISU
// Côté Dev Dashboard, l'app doit déclarer REDIRECT_URI et les scopes SCOPES.
const {
  signState, readStateSlug, verifyState, verifyShopifyHmac, isValidShopDomain,
} = require('../gifting/oauth');

const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/shopify/readonly-callback';
// 18/09 : ajout de read_products et read_inventory. La disponibilité était
// lue sur la vitrine publique, qui répondait « épuisé » pour tout (Alice a
// annoncé une rupture à une influenceuse sur une paire dont nous avions 24
// exemplaires en 37, et le gifting était bloqué). Elle se lit désormais sur
// l'API Admin. Là encore, un jeton garde les droits qu'il avait à sa
// création : il faut refaire la connexion après avoir mis l'app à jour.
const SCOPES = 'read_orders,read_all_orders,read_products,read_inventory';

function appCredentials(slug) {
  const key = String(slug || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const clientId = process.env[`SHOPIFY_READONLY_CLIENT_ID_${key}`];
  const clientSecret = process.env[`SHOPIFY_READONLY_CLIENT_SECRET_${key}`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

module.exports = {
  REDIRECT_URI, SCOPES, appCredentials,
  signState, readStateSlug, verifyState, verifyShopifyHmac, isValidShopDomain,
};
