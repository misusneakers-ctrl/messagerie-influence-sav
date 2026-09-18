// lib/ai/stock.js
// Ajout 2026-09-16 (brouillons IA) : vérification de disponibilité d'un
// modèle / d'une pointure, pour qu'Alice (ou Louise) n'écrive jamais
// « bien disponible en 38 » sans l'avoir vérifié.
//
// RÉÉCRIT LE 18/09 — voir lib/shopify/product-stock.js pour le détail du
// diagnostic. En résumé : la disponibilité était lue sur la vitrine publique
// à l'adresse `<boutique>.myshopify.com`, qui renvoyait `available: false`
// pour absolument tout. Résultat : Alice a annoncé « épuisé » à une
// influenceuse pour une paire dont nous avions 24 exemplaires en 37, et les
// commandes gifting étaient refusées avec `variant_unavailable`.
//
// Ordre de lecture désormais :
//   1. API Admin Shopify, jeton LECTURE SEULE (droits read_products +
//      read_inventory à ajouter, puis reconnexion) → vérité du stock, avec
//      le détail par emplacement ;
//   2. à défaut seulement, vitrine publique (ancien comportement), et le
//      résultat est alors marqué `source: 'vitrine_publique'`.
//
// Garde-fou : si la lecture ne trouve AUCUNE disponibilité sur AUCUN produit,
// on ajoute `note: 'aucune_disponibilite_lecture_douteuse'`. Le prompt
// d'Alice lui interdit d'annoncer une rupture sur cette base : elle remonte
// le ticket à Luc. C'est exactement la signature qu'avait le bug.

const { adminSearchProducts, adminGetProductByHandle } = require('../shopify/product-stock');

const SIZE_OPTION_RE = /taille|pointure|size/i;

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'messagerie-influence-sav/1.0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      const err = new Error(`http_${response.status}`);
      err.status = response.status;
      throw err;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // Page HTML (mot de passe, redirection vers une page d'accueil...).
      const err = new Error('reponse_non_json');
      err.code = 'not_json';
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSize(value) {
  return String(value || '').trim().replace(',', '.').replace(/\s+/g, '');
}

/**
 * Jeton Admin lecture seule. `accessToken` explicite prioritaire ; sinon on
 * le résout à partir du tenant. Toute erreur (app non configurée, credential
 * absente) rend null : on retombe alors sur la vitrine publique plutôt que
 * de faire échouer la vérification.
 * Le require est fait ici pour ne pas charger la base de données quand
 * l'appelant fournit déjà un jeton (tests, scripts).
 */
async function resolveToken({ tenant, accessToken }) {
  if (accessToken) return accessToken;
  if (!tenant || !tenant.id) return null;
  try {
    const { getReadonlyAccessToken } = require('../shopify/readonly-token');
    return await getReadonlyAccessToken(tenant);
  } catch {
    return null;
  }
}

function resolveDomain({ shopDomain, tenant }) {
  return shopDomain || (tenant && tenant.myshopify_domain) || null;
}

// ---------------------------------------------------------------------------
// Vitrine publique (secours)
// ---------------------------------------------------------------------------

/** Fiche produit publique détaillée (variantes avec id, SKU, pointure, dispo). */
async function publicProductDetail(shopDomain, handle) {
  const detail = await fetchJson(`https://${shopDomain}/products/${encodeURIComponent(handle)}.js`);
  const options = Array.isArray(detail.options) ? detail.options : [];
  let sizeIndex = options.findIndex((o) => SIZE_OPTION_RE.test(o.name || ''));
  if (sizeIndex < 0) sizeIndex = Math.max(0, options.length - 1);
  const variants = (detail.variants || []).map((v) => ({
    variant_id: v.id != null ? String(v.id) : null,
    sku: v.sku || null,
    size: (Array.isArray(v.options) ? v.options[sizeIndex] : null) || v.title,
    title: v.title,
    available: !!v.available,
    stock: null,
    locations: [],
    price_cents: typeof v.price === 'number' ? v.price : null,
  }));
  return {
    title: detail.title,
    handle: detail.handle || handle,
    url: `https://${shopDomain}/products/${detail.handle || handle}`,
    image: detail.featured_image || null,
    available: !!detail.available,
    variants,
    source: 'vitrine_publique',
  };
}

async function publicSearchProducts({ shopDomain, query, limit }) {
  let suggest;
  try {
    suggest = await fetchJson(
      `https://${shopDomain}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${Math.min(10, limit + 1)}`
    );
  } catch (err) {
    const e = new Error('boutique_inaccessible');
    e.code = 'boutique_inaccessible';
    e.detail = err.message;
    throw e;
  }
  const found = suggest?.resources?.results?.products || [];
  const products = [];
  for (const p of found.slice(0, limit)) {
    try {
      products.push(await publicProductDetail(shopDomain, p.handle));
    } catch {
      products.push({ title: p.title, handle: p.handle, error: 'fiche_illisible', variants: [], source: 'vitrine_publique' });
    }
  }
  return products;
}

// ---------------------------------------------------------------------------
// API publique du module
// ---------------------------------------------------------------------------

/**
 * Fiche produit détaillée. Admin d'abord, vitrine publique en secours.
 * Signature positionnelle conservée : getProductDetail(shopDomain, handle).
 */
async function getProductDetail(shopDomain, handle, opts = {}) {
  const domain = resolveDomain({ shopDomain, tenant: opts.tenant });
  const token = await resolveToken(opts);
  if (token) {
    try {
      return await adminGetProductByHandle({ shopDomain: domain, accessToken: token, handle });
    } catch (err) {
      if (err.code === 'produit_introuvable') throw err;
      // Droits insuffisants, API en panne… : on tente la vitrine, mais on
      // laisse une trace dans les logs — un repli muet a coûté deux jours.
      console.error('[stock] fiche Admin indisponible :', String(err.message || err).slice(0, 300));
    }
  }
  return publicProductDetail(domain, handle);
}

/**
 * Recherche : jusqu'à `limit` produits avec leurs variantes.
 *
 * Stratégie (révisée le 18/09, après que la première version soit restée
 * silencieusement sur la vitrine publique) :
 *   1. recherche sur l'API Admin ;
 *   2. si elle ne donne rien, on cherche les HANDLES sur la vitrine publique
 *      — c'est la seule chose qu'elle a toujours faite correctement, y
 *      compris pendant le bug — puis on relit chaque fiche sur l'Admin pour
 *      obtenir la vraie disponibilité ;
 *   3. en dernier recours seulement, la fiche publique telle quelle.
 * `diag` recueille la raison d'un échec Admin : elle est remontée dans le
 * résultat de checkStock et tracée dans l'analyse du ticket.
 */
async function searchProducts({ shopDomain, tenant, accessToken, query, limit = 5, diag = {} }) {
  const domain = resolveDomain({ shopDomain, tenant });
  const q = String(query || '').trim().slice(0, 80);
  if (!domain || !q) return [];
  const token = await resolveToken({ tenant, accessToken });
  if (!token) {
    diag.admin_error = 'jeton_lecture_absent';
    return publicSearchProducts({ shopDomain: domain, query: q, limit });
  }

  // 1. Recherche Admin.
  try {
    const found = await adminSearchProducts({ shopDomain: domain, accessToken: token, query: q, limit });
    if (found.length) return found;
    diag.admin_search = 'aucun_resultat';
  } catch (err) {
    diag.admin_error = String(err.message || err).slice(0, 300);
    console.error('[stock] recherche Admin indisponible :', diag.admin_error);
  }

  // 2. Handles via la vitrine, disponibilité via l'Admin.
  let publics = [];
  try {
    publics = await publicSearchProducts({ shopDomain: domain, query: q, limit });
  } catch (err) {
    if (diag.admin_error) throw err; // ni Admin ni vitrine : on ne ment pas
    throw err;
  }
  const out = [];
  for (const p of publics) {
    if (!p.handle) { out.push(p); continue; }
    try {
      out.push(await adminGetProductByHandle({ shopDomain: domain, accessToken: token, handle: p.handle }));
    } catch (err) {
      if (!diag.admin_error) {
        diag.admin_error = String(err.message || err).slice(0, 300);
        console.error('[stock] fiche Admin indisponible :', diag.admin_error);
      }
      out.push(p);
    }
  }
  return out;
}

/**
 * Pour l'IA (outil verifier_stock) : jusqu'à 5 produits correspondant à
 * `query`, avec les pointures disponibles / indisponibles.
 * Si `size` est fourni, ajoute `requested_size_available` par produit.
 */
async function checkStock({ shopDomain, tenant, accessToken, query, size }) {
  const domain = resolveDomain({ shopDomain, tenant });
  if (!domain) return { error: 'boutique_inconnue' };
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { error: 'recherche_vide' };

  const diag = {};
  let found;
  try {
    found = await searchProducts({ shopDomain: domain, tenant, accessToken, query: q, limit: 5, diag });
  } catch (err) {
    return { error: 'boutique_inaccessible', detail: err.detail || err.message };
  }
  if (found.length === 0) {
    return { query: q, products: [], note: 'aucun_produit_trouve' };
  }

  const wanted = size != null && String(size).trim() !== '' ? normalizeSize(size) : null;
  const products = found.map((p) => {
    if (p.error) return { title: p.title, handle: p.handle, error: p.error };
    const entry = {
      title: p.title,
      handle: p.handle,
      url: p.url,
      available: p.available,
      sizes_available: p.variants.filter((v) => v.available).map((v) => v.size),
      sizes_unavailable: p.variants.filter((v) => !v.available).map((v) => v.size),
    };
    if (wanted) {
      const match = p.variants.find((v) => normalizeSize(v.size) === wanted);
      entry.requested_size = wanted;
      entry.requested_size_available = match ? match.available : null; // null = pointure inexistante
      if (match) {
        entry.requested_variant_id = match.variant_id;
        entry.requested_sku = match.sku;
        if (match.stock != null) entry.requested_stock = match.stock;
        if (match.locations && match.locations.length) entry.requested_stock_par_emplacement = match.locations;
      }
    }
    return entry;
  });

  const source = found.find((p) => p.source)?.source || null;
  const result = { query: q, products };
  if (source) result.source = source;
  // Pourquoi la lecture Admin n'a pas abouti, le cas échéant : visible dans
  // ai_analysis.stock_checks et repris dans l'alerte posée à Luc.
  if (diag.admin_error) result.admin_error = diag.admin_error;
  if (diag.admin_search) result.admin_search = diag.admin_search;

  // Garde-fou : aucune disponibilité nulle part, sur plusieurs produits, est
  // la signature exacte du bug du 17-18/09. Ce n'est pas une rupture, c'est
  // une lecture à ne pas croire.
  const lisibles = products.filter((p) => !p.error);
  if (lisibles.length >= 2 && lisibles.every((p) => p.available === false)) {
    result.note = 'aucune_disponibilite_lecture_douteuse';
  }
  return result;
}

module.exports = {
  checkStock, searchProducts, getProductDetail, normalizeSize,
  publicProductDetail, publicSearchProducts,
};
