// lib/gifting/shopify-admin.js
// Ajout 2026-09-16 (commande gifting influenceuse), demandé par Luc : « une
// fois la commande de l'influenceuse validée, Alice doit être capable de
// passer une commande directement sur Shopify pour envoyer la paire ».
//
// Client Admin API Shopify (GraphQL) utilisé UNIQUEMENT pour les commandes
// de gifting à 0 €. Credential dédiée `shopify_gifting` (app Dev Dashboard
// séparée, scopes write_draft_orders + read_orders), distincte de
// `shopify_readonly` (lecture SAV) — principe de moindre privilège : aucune
// fonction de remboursement, d'annulation ou de modification de commande
// existante dans ce fichier, uniquement :
//   - créer une commande brouillon + la valider (0 €, remise 100 %) ;
//   - lire les commandes de gifting passées (compteur de quota).
//
// Reproduit exactement la façon dont BBP passe ses commandes de gifting à la
// main (vérifié le 16/09 sur C294902 et C294906) : commande brouillon, remise
// manuelle 100 % intitulée « Gifting influence Instagram », livraison gratuite
// « Colissimo » (France) ou « UPS International » (étranger), validée à 0 €,
// puis prise en charge par la logistique habituelle (MOBILTRON).

const API_VERSION = '2025-10';

async function adminGraphql({ shopDomain, accessToken, query, variables, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.errors) {
      const err = new Error(payload.errors ? JSON.stringify(payload.errors).slice(0, 500) : `shopify_http_${response.status}`);
      err.code = 'shopify_admin_error';
      err.status = response.status;
      throw err;
    }
    return payload.data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('shopify_timeout');
      e.code = 'shopify_timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const DRAFT_ORDER_CREATE = `
  mutation GiftingDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }`;

const DRAFT_ORDER_COMPLETE = `
  mutation CompleteGifting($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { id order { id name } }
      userErrors { field message }
    }
  }`;

const GIFTING_ORDERS = `
  query GiftingQuota($q: String!, $after: String) {
    orders(first: 100, after: $after, query: $q) {
      nodes { name cancelledAt lineItems(first: 20) { nodes { sku quantity } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const SHOP_IDENTITY = `query ShopIdentity { shop { name myshopifyDomain primaryDomain { host } } }`;

/**
 * Crée la commande brouillon puis la valide. Retourne { draftOrderId,
 * orderId, orderName }. En cas d'échec APRÈS création du brouillon, l'erreur
 * porte `draftOrderId` pour que Luc puisse finir à la main dans Shopify.
 */
async function createAndCompleteGiftingOrder({ shopDomain, accessToken, input }) {
  const created = await adminGraphql({ shopDomain, accessToken, query: DRAFT_ORDER_CREATE, variables: { input } });
  const createErrors = created?.draftOrderCreate?.userErrors || [];
  const draft = created?.draftOrderCreate?.draftOrder;
  if (createErrors.length || !draft) {
    const err = new Error(createErrors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join(' ; ') || 'draft_create_failed');
    err.code = 'draft_create_failed';
    throw err;
  }
  if (Number(draft.totalPriceSet?.shopMoney?.amount || 0) !== 0) {
    // Garde-fou : une commande de gifting doit être à 0 €. On ne valide pas
    // un brouillon qui ne l'est pas (remise mal appliquée, frais de port...).
    const err = new Error(`Le brouillon ${draft.name} n'est pas à 0 € (${draft.totalPriceSet.shopMoney.amount} €) : non validé.`);
    err.code = 'draft_not_zero';
    err.draftOrderId = draft.id;
    err.draftOrderName = draft.name;
    throw err;
  }
  let completed;
  try {
    completed = await adminGraphql({ shopDomain, accessToken, query: DRAFT_ORDER_COMPLETE, variables: { id: draft.id } });
  } catch (e) {
    e.draftOrderId = draft.id;
    e.draftOrderName = draft.name;
    throw e;
  }
  const completeErrors = completed?.draftOrderComplete?.userErrors || [];
  const order = completed?.draftOrderComplete?.draftOrder?.order;
  if (completeErrors.length || !order) {
    const err = new Error(completeErrors.map((e) => e.message).join(' ; ') || 'draft_complete_failed');
    err.code = 'draft_complete_failed';
    err.draftOrderId = draft.id;
    err.draftOrderName = draft.name;
    throw err;
  }
  return { draftOrderId: draft.id, draftOrderName: draft.name, orderId: order.id, orderName: order.name };
}

/**
 * Compte les paires déjà offertes pour un modèle/coloris : commandes portant
 * la remise de gifting (y compris celles passées à la main), non annulées,
 * dont une ligne a un SKU commençant par la clé modèle/coloris.
 */
async function countGiftedForColorway({ shopDomain, accessToken, discountTitle, colorwayKey }) {
  const q = `discount_code:"${String(discountTitle).replace(/"/g, '')}"`;
  let after = null;
  let count = 0;
  const orders = [];
  for (let page = 0; page < 5; page++) {
    const data = await adminGraphql({ shopDomain, accessToken, query: GIFTING_ORDERS, variables: { q, after } });
    const conn = data?.orders;
    for (const o of conn?.nodes || []) {
      if (o.cancelledAt) continue;
      const qty = (o.lineItems?.nodes || [])
        .filter((li) => li.sku && (li.sku === colorwayKey || li.sku.startsWith(colorwayKey + '-')))
        .reduce((s, li) => s + (li.quantity || 0), 0);
      if (qty > 0) { count += qty; orders.push(o.name); }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { count, orders };
}

async function getShopIdentity({ shopDomain, accessToken }) {
  const data = await adminGraphql({ shopDomain, accessToken, query: SHOP_IDENTITY });
  return data?.shop || null;
}

module.exports = { adminGraphql, createAndCompleteGiftingOrder, countGiftedForColorway, getShopIdentity, API_VERSION };
