// Résolution du tenant à partir d'une requête entrante.
// Deux voies : header X-Shop-Domain (appels internes/outillage) ou clé API
// Bearer (webhooks, intégrations externes). La résolution elle-même
// interroge la table tenants SANS scope RLS (withoutTenant) puisque c'est
// justement la table qui n'a pas de tenant_id.

const { withoutTenant } = require('./db');

async function resolveTenantBySlug(slug) {
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      'SELECT id, slug, name, myshopify_domain, plan FROM tenants WHERE slug = $1',
      [slug]
    );
    return rows[0] || null;
  });
}

async function resolveTenantByDomain(domain) {
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      'SELECT id, slug, name, myshopify_domain, plan FROM tenants WHERE myshopify_domain = $1',
      [domain]
    );
    return rows[0] || null;
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

module.exports = { resolveTenantFromRequest, resolveTenantBySlug, resolveTenantByDomain };
