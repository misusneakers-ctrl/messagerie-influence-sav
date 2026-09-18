// Résolution du tenant à partir d'une requête entrante.
// Deux voies : header X-Shop-Domain (appels internes/outillage) ou clé API
// Bearer (webhooks, intégrations externes). La résolution elle-même
// interroge la table tenants SANS scope RLS (withoutTenant) puisque c'est
// justement la table qui n'a pas de tenant_id.

const { withoutTenant } = require('./db');

// Cache mémoire ajouté le 18/09 (chantier lenteur). La table `tenants`
// contient deux lignes qui ne changent jamais, et elle était relue à CHAQUE
// requête HTTP — une connexion et un aller-retour avant le moindre travail
// utile. Le cache vit dans l'instance Vercel et disparaît au redéploiement ;
// 5 minutes suffisent à couvrir une rafale de requêtes sans jamais servir
// une marque périmée.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // clé « slug:bbp » ou « domain:x.myshopify.com » → { at, tenant }

function lire(cle) {
  const e = cache.get(cle);
  if (!e || Date.now() - e.at > CACHE_MS) return undefined;
  return e.tenant;
}

function ecrire(cle, tenant) {
  if (tenant) cache.set(cle, { at: Date.now(), tenant });
  return tenant;
}

async function resolveTenantBySlug(slug) {
  const cle = 'slug:' + slug;
  const connu = lire(cle);
  if (connu !== undefined) return connu;
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      'SELECT id, slug, name, myshopify_domain, plan FROM tenants WHERE slug = $1',
      [slug]
    );
    return ecrire(cle, rows[0] || null);
  });
}

async function resolveTenantByDomain(domain) {
  const cle = 'domain:' + domain;
  const connu = lire(cle);
  if (connu !== undefined) return connu;
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      'SELECT id, slug, name, myshopify_domain, plan FROM tenants WHERE myshopify_domain = $1',
      [domain]
    );
    return ecrire(cle, rows[0] || null);
  });
}

/**
 * Résout le tenant pour une requête HTTP entrante. Ordre de priorité :
 * 1. header X-Shop-Domain (ex. bons-baisers.myshopify.com)
 * 2. header X-Tenant-Slug (ex. bbp) — pratique pour les tests manuels
 * Retourne null si rien ne correspond ; à l'appelant de renvoyer 400/404.
 */
async function resolveTenantFromRequest(req) {
  const domain = req.headers['x-shop-domain'];
  if (domain) {
    const tenant = await resolveTenantByDomain(String(domain));
    if (tenant) return tenant;
  }
  const slug = req.headers['x-tenant-slug'];
  if (slug) {
    const tenant = await resolveTenantBySlug(String(slug));
    if (tenant) return tenant;
  }
  return null;
}

module.exports = { resolveTenantFromRequest, resolveTenantBySlug, resolveTenantByDomain, _cache: cache };
