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
 * Cherche jusqu'à 5 produits correspondant à `query` et renvoie, pour
 * chacun, la liste des pointures avec leur disponibilité.
 * Si `size` est fourni, ajoute `requested_size_available` par produit.
 */
async function checkStock({ shopDomain, query, size }) {
  if (!shopDomain) return { error: 'boutique_inconnue' };
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { error: 'recherche_vide' };

  let suggest;
  try {
    suggest = await fetchJson(
      `https://${shopDomain}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=6`
    );
  } catch (err) {
    return { error: 'boutique_inaccessible', detail: err.message };
  }
  const found = suggest?.resources?.results?.products || [];
  if (found.length === 0) {
    return { query: q, products: [], note: 'aucun_produit_trouve' };
  }

  const wanted = size != null && String(size).trim() !== '' ? normalizeSize(size) : null;
  const products = [];
  for (const p of found.slice(0, 5)) {
    try {
      const detail = await fetchJson(`https://${shopDomain}/products/${encodeURIComponent(p.handle)}.js`);
      const options = Array.isArray(detail.options) ? detail.options : [];
      let sizeIndex = options.findIndex((o) => SIZE_OPTION_RE.test(o.name || ''));
      if (sizeIndex < 0) sizeIndex = Math.max(0, options.length - 1);
      const sizes = (detail.variants || []).map((v) => ({
        size: (Array.isArray(v.options) ? v.options[sizeIndex] : null) || v.title,
        available: !!v.available,
      }));
      const entry = {
        title: detail.title || p.title,
        handle: p.handle,
        url: `https://${shopDomain}/products/${p.handle}`,
        available: !!detail.available,
        sizes_available: sizes.filter((s) => s.available).map((s) => s.size),
        sizes_unavailable: sizes.filter((s) => !s.available).map((s) => s.size),
      };
      if (wanted) {
        const match = sizes.find((s) => normalizeSize(s.size) === wanted);
        entry.requested_size = wanted;
        entry.requested_size_available = match ? match.available : null; // null = pointure inexistante
      }
      products.push(entry);
    } catch (err) {
      products.push({ title: p.title, handle: p.handle, error: 'fiche_illisible' });
    }
  }
  return { query: q, products };
}

module.exports = { checkStock };
