// lib/gifting/orders.js
// Ajout 2026-09-16 (commande gifting influenceuse). Décisions de Luc :
// - « Alice prépare, tu cliques » : l'IA pré-remplit la commande (modèle,
//   pointure, coordonnées tirées de la conversation), Luc relit et clique.
//   Aucune commande n'est jamais créée automatiquement.
// - Pas d'e-mail de confirmation Shopify voulu : Alice confirme par DM.
// - Quota : 5 paires maximum par modèle/coloris sur une collection (lu dans
//   le SKU : « 1-S25-EPLEO-BLA-36 » → modèle/coloris « 1-S25-EPLEO-BLA »,
//   collection « S25 »), toutes pointures confondues. Au-delà : refus, sauf
//   accord explicite de Luc (override_quota).
//
// Garde-fous appliqués côté serveur (pas seulement dans l'interface) :
// collaboration acceptée (décision de Luc OU proposition de la marque dans
// la conversation), variante disponible, quota, pas de doublon pour le même
// ticket, clé d'idempotence (double clic), commande à 0 € vérifiée avant
// validation, filtrage tenant_id partout, journal d'audit.

const { withTenant } = require('../db');
const { decrypt } = require('../crypto');
const { logAudit } = require('../audit');
const { loadAiSettings } = require('../ai/assistant');
const { searchProducts, getProductDetail, normalizeSize } = require('../ai/stock');
const shopifyAdmin = require('./shopify-admin');
const { getValidAccessToken } = require('./token');

const COUNTRY_ALIASES = {
  FR: ['france', 'fr', 'fra'],
  BE: ['belgique', 'belgium', 'be', 'belgie', 'belgië'],
  CH: ['suisse', 'switzerland', 'ch', 'schweiz'],
  LU: ['luxembourg', 'lu'],
  MC: ['monaco', 'mc'],
  DE: ['allemagne', 'germany', 'deutschland', 'de'],
  ES: ['espagne', 'spain', 'espana', 'españa', 'es'],
  IT: ['italie', 'italy', 'italia', 'it'],
  NL: ['pays-bas', 'pays bas', 'netherlands', 'nederland', 'nl'],
  GB: ['royaume-uni', 'royaume uni', 'united kingdom', 'uk', 'gb', 'angleterre'],
  PT: ['portugal', 'pt'],
};
const PHONE_PREFIX = { FR: '33', BE: '32', CH: '41', LU: '352', MC: '377', DE: '49', ES: '34', IT: '39', NL: '31', GB: '44', PT: '351' };

function colorwayFromSku(sku) {
  const parts = String(sku || '').trim().split('-').filter(Boolean);
  if (parts.length < 2) return { colorwayKey: sku || null, collection: null };
  if (/^\d{2}([.,]5)?$/.test(parts[parts.length - 1])) parts.pop();
  const collection = parts.find((p) => /^[A-Z]{1,3}\d{2}$/i.test(p)) || null;
  return { colorwayKey: parts.join('-'), collection: collection ? collection.toUpperCase() : null };
}

function normalizeCountry(text, zip) {
  const t = String(text || '').trim().toLowerCase();
  if (/^[a-z]{2}$/i.test(t) && PHONE_PREFIX[t.toUpperCase()]) return t.toUpperCase();
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) {
    if (names.includes(t)) return code;
  }
  if (!t && /^\d{5}$/.test(String(zip || '').trim())) return 'FR';
  return t ? null : null;
}

function normalizePhone(phone, countryCode) {
  let p = String(phone || '').replace(/[\s.\-()]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+')) return p;
  const prefix = PHONE_PREFIX[countryCode];
  if (prefix && p.startsWith('0')) return '+' + prefix + p.slice(1);
  return p;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function httpError(status, code, extra = {}) {
  const err = new Error(code);
  err.httpStatus = status;
  err.code = code;
  err.extra = extra;
  return err;
}

async function loadGiftingCredential(client, tenant) {
  const { rows } = await client.query(
    `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_gifting'`,
    [tenant.id]
  );
  if (!rows[0]) return null;
  const meta = rows[0].metadata || {};
  const shopDomain = meta.shop || tenant.myshopify_domain;
  // Jeton permanent (app personnalisée) ou jeton expirant + refresh (voir lib/gifting/token.js).
  const accessToken = await getValidAccessToken({
    client, tenant, shopDomain, stored: decrypt(rows[0].encrypted_value),
  });
  return { accessToken, shopDomain, scope: meta.scope || '', metadata: meta };
}

function isGiftingApproved(ticket, relation) {
  if ((relation && relation.gifting_decision === 'approved') || ticket.gifting_decision === 'approved') return 'decision_luc';
  if (ticket.ai_analysis && ticket.ai_analysis.brand_proposed_gifting === true) return 'proposition_marque';
  return null;
}

async function loadTicketBundle(client, tenant, ticketId) {
  const { rows } = await client.query('SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2', [ticketId, tenant.id]);
  const ticket = rows[0];
  if (!ticket) throw httpError(404, 'ticket_not_found');
  let relation = null;
  if (ticket.influence_relation_id) {
    const { rows: rel } = await client.query(
      'SELECT * FROM tenant_influence_relations WHERE id = $1 AND tenant_id = $2',
      [ticket.influence_relation_id, tenant.id]
    );
    relation = rel[0] || null;
  }
  const { rows: orders } = await client.query(
    `SELECT id, status, product_title, size, sku, order_name, order_id, draft_order_id, error, created_by, created_at
     FROM gifting_orders WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY created_at DESC`,
    [tenant.id, ticketId]
  );
  return { ticket, relation, orders };
}

async function quotaFor(cred, settings, sku) {
  const { colorwayKey, collection } = colorwayFromSku(sku);
  const limit = settings.gifting_quota_per_colorway != null ? Number(settings.gifting_quota_per_colorway) : 5;
  if (!cred || !colorwayKey) return { colorway_key: colorwayKey, collection, limit, count: null, orders: [], error: cred ? null : 'shopify_gifting_not_connected' };
  try {
    const { count, orders } = await shopifyAdmin.countGiftedForColorway({
      shopDomain: cred.shopDomain,
      accessToken: cred.accessToken,
      discountTitle: settings.gifting_discount_title || 'Gifting influence Instagram',
      colorwayKey,
    });
    return { colorway_key: colorwayKey, collection, limit, count, orders, remaining: Math.max(0, limit - count) };
  } catch (err) {
    return { colorway_key: colorwayKey, collection, limit, count: null, orders: [], error: err.code || err.message };
  }
}

/**
 * Résumé léger (panneau du ticket) : éligibilité + commandes déjà passées.
 */
async function getGiftingSummary(tenant, ticketId) {
  return withTenant(tenant.id, async (client) => {
    const { ticket, relation, orders } = await loadTicketBundle(client, tenant, ticketId);
    const { rows: credRows } = await client.query(
      `SELECT metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_gifting'`,
      [tenant.id]
    );
    return {
      approved_by: isGiftingApproved(ticket, relation),
      connected: !!credRows[0],
      orders,
    };
  });
}

/**
 * Proposition complète (fenêtre de création) : produit/pointure retrouvés à
 * partir de l'analyse IA, coordonnées pré-remplies, quota du modèle/coloris.
 */
async function buildGiftingProposal(tenant, ticketId) {
  const base = await withTenant(tenant.id, async (client) => {
    const bundle = await loadTicketBundle(client, tenant, ticketId);
    const settings = await loadAiSettings(client, tenant);
    let cred = null;
    try { cred = await loadGiftingCredential(client, tenant); } catch (e) { cred = null; }
    return { ...bundle, settings, cred };
  });
  const { ticket, relation, orders, settings, cred } = base;
  const analysis = ticket.ai_analysis || {};
  const item = (Array.isArray(analysis.requested_items) && analysis.requested_items[0]) || null;
  const shop = tenant.myshopify_domain;

  let candidates = [];
  let selected = null;
  let productError = null;
  try {
    if (item && item.product_handle) {
      const detail = await getProductDetail(shop, item.product_handle);
      candidates = [detail];
    }
    if (candidates.length === 0 && item && (item.model || item.color)) {
      candidates = await searchProducts({ shopDomain: shop, query: [item.model, item.color].filter(Boolean).join(' '), limit: 5 });
    }
  } catch (err) {
    productError = err.code || err.message;
  }
  if (candidates.length && item) {
    const product = candidates[0];
    const variant = (product.variants || []).find((v) => (item.variant_id && v.variant_id === String(item.variant_id)))
      || (product.variants || []).find((v) => item.size && normalizeSize(v.size) === normalizeSize(item.size));
    selected = { product_handle: product.handle, variant_id: variant ? variant.variant_id : null };
  }

  const sd = analysis.shipping_details || {};
  const { firstName, lastName } = splitName(sd.full_name || ticket.contact_name || '');
  const countryCode = normalizeCountry(sd.country, sd.postal_code) || (sd.postal_code ? null : 'FR');
  const address = {
    first_name: firstName,
    last_name: lastName,
    address1: sd.address || '',
    address2: '',
    zip: sd.postal_code || '',
    city: sd.city || '',
    country_code: countryCode || '',
    phone: sd.phone || '',
    email: sd.email || ticket.contact_email || '',
  };

  let quota = null;
  const selVariant = selected && candidates[0] && (candidates[0].variants || []).find((v) => v.variant_id === selected.variant_id);
  if (selVariant && selVariant.sku) quota = await quotaFor(cred, settings, selVariant.sku);

  return {
    approved_by: isGiftingApproved(ticket, relation),
    connected: !!cred,
    orders,
    requested_item: item,
    candidates,
    selected,
    product_error: productError,
    address,
    quota,
    settings: {
      quota_limit: settings.gifting_quota_per_colorway,
      discount_title: settings.gifting_discount_title,
      shipping_title_fr: settings.gifting_shipping_title_fr,
      shipping_title_intl: settings.gifting_shipping_title_intl,
    },
  };
}

async function getQuotaForSku(tenant, sku) {
  return withTenant(tenant.id, async (client) => {
    const settings = await loadAiSettings(client, tenant);
    let cred = null;
    try { cred = await loadGiftingCredential(client, tenant); } catch (e) { cred = null; }
    return { settings, cred };
  }).then(({ settings, cred }) => quotaFor(cred, settings, sku));
}

/**
 * Création de la commande (clic de Luc).
 * body : { product_handle, variant_id, first_name, last_name, address1,
 *   address2, zip, city, country_code, phone, email, idempotency_key,
 *   override_quota, override_stock, override_duplicate }
 */
async function createGiftingOrder(tenant, ticketId, body, actor) {
  const b = body || {};
  const required = ['product_handle', 'variant_id', 'first_name', 'last_name', 'address1', 'zip', 'city', 'country_code'];
  const missing = required.filter((f) => !String(b[f] || '').trim());
  if (missing.length) throw httpError(400, 'missing_fields', { fields: missing });
  const countryCode = String(b.country_code).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw httpError(400, 'invalid_country_code');
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) throw httpError(400, 'invalid_email');
  if (!actor) throw httpError(400, 'created_by_required');
  const idempotencyKey = b.idempotency_key ? String(b.idempotency_key).slice(0, 100) : null;

  // 1. Contrôles base (ticket, éligibilité, credential, doublons, idempotence).
  const pre = await withTenant(tenant.id, async (client) => {
    const bundle = await loadTicketBundle(client, tenant, ticketId);
    if (idempotencyKey) {
      const { rows } = await client.query(
        'SELECT * FROM gifting_orders WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenant.id, idempotencyKey]
      );
      if (rows[0]) return { ...bundle, replay: rows[0] };
    }
    const approvedBy = isGiftingApproved(bundle.ticket, bundle.relation);
    if (!approvedBy) throw httpError(409, 'gifting_not_approved');
    const settings = await loadAiSettings(client, tenant);
    const cred = await loadGiftingCredential(client, tenant);
    if (!cred) throw httpError(409, 'shopify_gifting_not_connected');
    if (!/write_draft_orders/.test(cred.scope || 'write_draft_orders')) throw httpError(409, 'shopify_gifting_missing_scope');
    const inProgress = bundle.orders.find((o) => o.status === 'pending' && Date.now() - new Date(o.created_at).getTime() < 3 * 60 * 1000);
    if (inProgress) throw httpError(409, 'order_in_progress');
    const existing = bundle.orders.find((o) => o.status === 'created');
    if (existing && !b.override_duplicate) throw httpError(409, 'already_ordered', { order_name: existing.order_name });
    return { ...bundle, approvedBy, settings, cred };
  });
  if (pre.replay) return { gifting_order: pre.replay, replay: true };
  const { ticket, relation, settings, cred, approvedBy } = pre;

  // 2. Variante (données publiques de la boutique) + disponibilité.
  let product;
  try {
    product = await getProductDetail(tenant.myshopify_domain, String(b.product_handle));
  } catch (err) {
    throw httpError(502, 'product_lookup_failed', { detail: err.message });
  }
  const variant = (product.variants || []).find((v) => v.variant_id === String(b.variant_id));
  if (!variant) throw httpError(400, 'variant_not_found');
  if (!variant.available && !b.override_stock) throw httpError(409, 'variant_unavailable', { size: variant.size });

  // 3. Quota modèle/coloris.
  const quota = await quotaFor(cred, settings, variant.sku);
  if (quota.count == null && !b.override_quota) throw httpError(502, 'quota_check_failed', { detail: quota.error });
  if (quota.count != null && quota.count + 1 > quota.limit && !b.override_quota) {
    throw httpError(409, 'quota_reached', { count: quota.count, limit: quota.limit, colorway_key: quota.colorway_key, collection: quota.collection });
  }

  // 4. Trace "pending" AVANT l'appel Shopify (bloque un double clic / double onglet).
  const shipping = {
    firstName: String(b.first_name).trim(),
    lastName: String(b.last_name).trim(),
    address1: String(b.address1).trim(),
    address2: String(b.address2 || '').trim() || null,
    zip: String(b.zip).trim(),
    city: String(b.city).trim(),
    countryCode,
    phone: normalizePhone(b.phone, countryCode),
  };
  const email = b.email ? String(b.email).trim() : null;
  const overrides = { quota: !!b.override_quota, stock: !!b.override_stock, duplicate: !!b.override_duplicate };
  const row = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO gifting_orders (tenant_id, ticket_id, influence_relation_id, status, idempotency_key, product_title, product_handle,
         variant_id, sku, size, colorway_key, shipping_address, email, quota_count_before, quota_limit, overrides, created_by)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [tenant.id, ticketId, ticket.influence_relation_id, idempotencyKey, product.title, product.handle, variant.variant_id,
        variant.sku, variant.size, quota.colorway_key, JSON.stringify(shipping), email, quota.count, quota.limit,
        JSON.stringify(overrides), actor]
    );
    return rows[0];
  });

  // 5. Commande Shopify (brouillon 0 € → validée).
  const handle = ticket.contact_handle ? '@' + ticket.contact_handle : (ticket.contact_name || 'influenceuse');
  const discountTitle = settings.gifting_discount_title || 'Gifting influence Instagram';
  const input = {
    lineItems: [{ variantId: `gid://shopify/ProductVariant/${variant.variant_id}`, quantity: 1 }],
    appliedDiscount: { title: discountTitle, description: discountTitle, value: 100, valueType: 'PERCENTAGE' },
    shippingLine: {
      title: countryCode === 'FR' ? (settings.gifting_shipping_title_fr || 'Colissimo') : (settings.gifting_shipping_title_intl || 'UPS International'),
      priceWithCurrency: { amount: '0.00', currencyCode: 'EUR' },
    },
    shippingAddress: shipping,
    billingAddress: shipping,
    tags: ['gifting-influence', 'messagerie-ia'],
    note: `${discountTitle} — ${handle} — préparée par l'assistante ${settings.signature_name || 'IA'} (messagerie), validée par ${actor}. Ticket ${ticketId}.`,
  };
  if (email) input.email = email;

  let result;
  try {
    result = await shopifyAdmin.createAndCompleteGiftingOrder({ shopDomain: cred.shopDomain, accessToken: cred.accessToken, input });
  } catch (err) {
    await withTenant(tenant.id, async (client) => {
      await client.query(
        `UPDATE gifting_orders SET status = 'failed', error = $1, draft_order_id = $2, updated_at = now() WHERE id = $3 AND tenant_id = $4`,
        [String(err.message || err.code).slice(0, 1000), err.draftOrderId || null, row.id, tenant.id]
      );
      await logAudit(client, tenant.id, {
        actor, action: 'gifting_order_failed', entityType: 'ticket', entityId: ticketId,
        details: { gifting_order_id: row.id, error: err.code || err.message, draft_order: err.draftOrderName || null },
      });
    });
    throw httpError(502, err.code || 'shopify_order_failed', { message: err.message, draft_order_name: err.draftOrderName || null });
  }

  // 6. Enregistrement + historique de la relation influence.
  const saved = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `UPDATE gifting_orders SET status = 'created', draft_order_id = $1, order_id = $2, order_name = $3, updated_at = now()
       WHERE id = $4 AND tenant_id = $5 RETURNING *`,
      [result.draftOrderId, result.orderId, result.orderName, row.id, tenant.id]
    );
    if (relation) {
      const entry = { order_name: result.orderName, sku: variant.sku, product: product.title, size: variant.size, date: new Date().toISOString(), by: actor };
      await client.query(
        `UPDATE tenant_influence_relations
         SET orders_or_gifting = COALESCE(orders_or_gifting, '[]'::jsonb) || $1::jsonb, updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [JSON.stringify([entry]), relation.id, tenant.id]
      );
    }
    await logAudit(client, tenant.id, {
      actor, action: 'gifting_order_created', entityType: 'ticket', entityId: ticketId,
      details: { gifting_order_id: row.id, order_name: result.orderName, sku: variant.sku, approved_by: approvedBy, quota_before: quota.count, quota_limit: quota.limit, overrides },
    });
    return rows[0];
  });
  return { gifting_order: saved, quota: { ...quota, count: quota.count != null ? quota.count + 1 : null } };
}

module.exports = {
  getGiftingSummary,
  buildGiftingProposal,
  createGiftingOrder,
  getQuotaForSku,
  _internal: { colorwayFromSku, normalizeCountry, normalizePhone, splitName, isGiftingApproved },
};
