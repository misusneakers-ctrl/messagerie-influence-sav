// lib/shopify/product-stock.js
// Ajout 2026-09-18 — correctif « Alice répond épuisé alors qu'on a du stock ».
//
// Constat (ticket @valentorya du 18/09 et ticket du 17/09) : l'outil
// verifier_stock a renvoyé « aucune pointure disponible » sur 10 produits,
// deux jours différents, alors que Shopify en comptait 154 exemplaires pour
// le seul modèle Elisabeth Suede Crème (24 en 37). Autrement dit : l'outil
// n'a JAMAIS renvoyé une seule disponibilité depuis sa mise en service.
//
// Cause : la disponibilité était lue sur la vitrine publique, à l'adresse
// `<boutique>.myshopify.com`, qui répond par une redirection 302 vers le
// domaine principal. Les titres, SKU et identifiants de variantes revenaient
// justes — seul le champ `available` revenait faux, pour tous les produits.
// Le même champ lu directement sur `www.bonsbaisers.paris` répond vrai.
// Conséquence silencieuse : lib/gifting/orders.js refuse toute commande avec
// `variant_unavailable`, donc le gifting était bloqué lui aussi.
//
// Correctif : la disponibilité se lit désormais sur l'API Admin Shopify, avec
// le jeton LECTURE SEULE déjà en place (lib/shopify/readonly-token.js). Il
// faut y ajouter les droits `read_products` et `read_inventory` et refaire la
// connexion, comme pour `read_all_orders` le 17/09. La vitrine publique reste
// en secours si le jeton manque.
//
// Bénéfice au passage : on voit le stock PAR EMPLACEMENT (MOBILTRON vs
// SHOWROOM TURBIGO), ce qui compte pour le gifting — une paire présente
// uniquement au showroom n'est pas expédiable par le logisticien.

const { adminGraphql } = require('../gifting/shopify-admin');

const SIZE_OPTION_RE = /taille|pointure|size/i;

/** Retire les accents et la ponctuation : « Crème » et « Creme » doivent matcher. */
function normalizeTerm(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Requête de recherche Admin : chaque mot doit être présent (ET implicite).
 * Les mots d'un seul caractère sont écartés (bruit).
 */
function buildSearchQuery(query) {
  const terms = normalizeTerm(query).split(/\s+/).filter((t) => t.length > 1);
  return terms.map((t) => `${t}*`);
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  featuredMedia { preview { image { url } } }
  variants(first: 50) {
    nodes {
      id
      title
      sku
      availableForSale
      inventoryQuantity
      inventoryPolicy
      selectedOptions { name value }
      inventoryItem {
        tracked
        inventoryLevels(first: 10) {
          nodes { location { id name } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }`;

const SEARCH_QUERY = `
  query StockSearch($q: String!, $n: Int!) {
    products(first: $n, query: $q) { nodes { ${PRODUCT_FIELDS} } }
  }`;

const BY_HANDLE_QUERY = `
  query StockByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { ${PRODUCT_FIELDS} }
  }`;

function numericId(gid) {
  const s = String(gid || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s || null;
}

function sizeOf(variant) {
  const opts = Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [];
  const match = opts.find((o) => SIZE_OPTION_RE.test(o.name || ''));
  if (match) return match.value;
  // Pas d'option nommée « pointure » : on prend la dernière (BEIGE / 37 → 37).
  return opts.length ? opts[opts.length - 1].value : variant.title;
}

/**
 * Convertit un produit Admin au format déjà attendu par le reste du code
 * (lib/ai/stock.js, lib/gifting/orders.js) : mêmes clés, mêmes types.
 * `variant_id` reste l'identifiant NUMÉRIQUE, comme la vitrine publique le
 * renvoyait — les commandes gifting déjà enregistrées restent valides.
 */
function mapProduct(shopDomain, node) {
  const variants = (node.variants?.nodes || []).map((v) => {
    const levels = (v.inventoryItem?.inventoryLevels?.nodes || []).map((l) => ({
      location: l.location?.name || null,
      available: Number(
        (l.quantities || []).find((q) => q.name === 'available')?.quantity ?? 0
      ),
    }));
    return {
      variant_id: numericId(v.id),
      sku: v.sku || null,
      size: sizeOf(v),
      title: v.title,
      available: !!v.availableForSale,
      stock: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
      continue_selling: v.inventoryPolicy === 'CONTINUE',
      locations: levels,
      price_cents: null, // non lu ici : le prix ne sert pas à la disponibilité
    };
  });
  return {
    title: node.title,
    handle: node.handle,
    url: `https://${shopDomain}/products/${node.handle}`,
    image: node.featuredMedia?.preview?.image?.url || null,
    status: node.status,
    available: variants.some((v) => v.available),
    variants,
    source: 'admin',
  };
}

/**
 * Recherche produits sur l'API Admin. Si tous les mots ensemble ne donnent
 * rien, on retire le dernier mot et on réessaie (« Elisabeth suede creme »
 * → « Elisabeth suede » → « Elisabeth ») : une influenceuse écrit rarement
 * le libellé exact du catalogue.
 */
async function adminSearchProducts({ shopDomain, accessToken, query, limit = 5 }) {
  const terms = buildSearchQuery(query);
  if (!terms.length) return [];
  for (let keep = terms.length; keep >= 1; keep -= 1) {
    const q = terms.slice(0, keep).join(' AND ');
    const data = await adminGraphql({
      shopDomain, accessToken, query: SEARCH_QUERY, variables: { q, n: limit },
    });
    const nodes = data?.products?.nodes || [];
    if (nodes.length) return nodes.map((n) => mapProduct(shopDomain, n));
  }
  return [];
}

async function adminGetProductByHandle({ shopDomain, accessToken, handle }) {
  const data = await adminGraphql({
    shopDomain, accessToken, query: BY_HANDLE_QUERY, variables: { handle: String(handle) },
  });
  const node = data?.productByIdentifier;
  if (!node) {
    const err = new Error('produit_introuvable');
    err.code = 'produit_introuvable';
    throw err;
  }
  return mapProduct(shopDomain, node);
}

module.exports = {
  adminSearchProducts, adminGetProductByHandle,
  mapProduct, buildSearchQuery, normalizeTerm, sizeOf, numericId,
};
