// lib/ai/stock.js
// Ajout 2026-09-16 (brouillons IA) : vérification de disponibilité d'un
// modèle / d'une pointure, pour qu'Alice (ou Louise) n'écrive jamais
// « bien disponible en 38 » sans l'avoir vérifié.
//
// Source : les données PUBLIQUES de la boutique Shopify (celles que voit
// n'importe quel visiteur du site) — recherche /search/suggest.json puis
// fiche /products/<handle>.js. Aucun jeton, aucun accès admin : les
// credentials Shopify de l'appli restent limitées à la lecture des
// commandes (voir lib/channels/shopify-readonly.js), rien n'est élargi.
//
// Limites assumées :
// - "available" est la disponibilité à la vente affichée sur le site : un
//   article en précommande / vente sans stock peut apparaître disponible ;
// - une boutique protégée par mot de passe (ex. Misü en construction) ne
//   renvoie rien : l'outil répond alors "boutique_inaccessible" et l'IA
//   pose l'alerte « stock à vérifier ».

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
 * Fiche produit publique détaillée (variantes avec id, SKU, pointure, dispo).
 * Ajout 2026-09-16 (commande gifting) : l'id de variante sert à créer la
 * commande Shopify, le SKU à compter le quota par modèle/coloris.
 */
async function getProductDetail(shopDomain, handle) {
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
    price_cents: typeof v.price === 'number' ? v.price : null,
  }));
  return {
    title: detail.title,
    handle: detail.handle || handle,
    url: `https://${shopDomain}/products/${detail.handle || handle}`,
    image: detail.featured_image || null,
    available: !!detail.available,
    variants,
  };
}

/**
 * Recherche publique : jusqu'à `limit` produits avec leurs variantes.
 * Lève une erreur code 'boutique_inaccessible' si la boutique ne répond pas.
 */
async function searchProducts({ shopDomain, query, limit = 5 }) {
  const q = String(query || '').trim().slice(0, 80);
  if (!shopDomain || !q) return [];
  let suggest;
  try {
    suggest = await fetchJson(
      `https://${shopDomain}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=${Math.min(10, limit + 1)}`
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
      products.push(await getProductDetail(shopDomain, p.handle));
    } catch (err) {
      products.push({ title: p.title, handle: p.handle, error: 'fiche_illisible', variants: [] });
    }
  }
  return products;
}

/**
 * Pour l'IA (outil verifier_stock) : jusqu'à 5 produits correspondant à
 * `query`, avec les pointures disponibles / indisponibles.
 * Si `size` est fourni, ajoute `requested_size_available` par produit.
 */
async function checkStock({ shopDomain, query, size }) {
  if (!shopDomain) return { error: 'boutique_inconnue' };
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { error: 'recherche_vide' };

  let found;
  try {
    found = await searchProducts({ shopDomain, query: q, limit: 5 });
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
      if (match) { entry.requested_variant_id = match.variant_id; entry.requested_sku = match.sku; }
    }
    return entry;
  });
  return { query: q, products };
}

module.exports = { checkStock, searchProducts, getProductDetail, normalizeSize };
