// Connexion Postgres + garde-fou RLS.
// withTenant(tenantId, fn) ouvre une transaction, pose app.tenant_id en SET LOCAL
// (donc jamais visible en dehors de la transaction), exécute fn(client), commit/rollback.
// C'est la SEULE façon prévue d'exécuter une requête scopée à une marque : impossible
// d'oublier le filtre tenant, la base elle-même le refuse (Row Level Security).

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL manquant');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

/**
 * Exécute fn(client) dans une transaction où app.tenant_id est posé pour la
 * durée de la transaction uniquement. tenantId doit être un UUID déjà résolu
 * (voir lib/tenant.js) — jamais une valeur venant directement d'un header.
 */
async function withTenant(tenantId, fn) {
  if (!tenantId) {
    throw new Error('withTenant() appelé sans tenantId');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Requête admin explicitement SANS scope tenant — réservée aux opérations
 * qui doivent, par nature, voir plusieurs marques : résolution du tenant
 * lui-même (lib/tenant.js), moteur de recherche influence transverse.
 * Ne jamais utiliser pour lire/écrire tickets, messages, credentials.
 */
async function withoutTenant(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant, withoutTenant };
