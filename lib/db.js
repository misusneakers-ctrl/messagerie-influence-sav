// Connexion Postgres + garde-fou RLS.
// withTenant(tenantId, fn) ouvre une transaction, pose app.tenant_id en SET LOCAL
// (donc jamais visible en dehors de la transaction), exécute fn(client), commit/rollback.
// C'est la SEULE façon prévue d'exécuter une requête scopée à une marque : impossible
// d'oublier le filtre tenant, la base elle-même le refuse (Row Level Security).

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL manquant');
}

// Réglages 2026-09-18 (chantier lenteur) : chaque instance Vercel a SA propre
// poule. `max: 5` × le nombre d'instances saturait la limite de connexions du
// plan Neon gratuit. keepAlive réutilise la connexion TCP entre deux requêtes
// de la même instance — sans lui, chaque appel refaisait la poignée de main
// TLS, ce qui coûtait très cher tant que la base était à Londres et les
// fonctions à Washington (voir PERFORMANCE.md).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  keepAlive: true,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Un identifiant de marque est toujours un UUID déjà résolu (lib/tenant.js).
// On le vérifie avant de l'insérer dans le SQL : c'est ce qui permet
// d'envoyer BEGIN et set_config en UNE seule requête au lieu de deux.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (UUID_RE.test(String(tenantId))) {
      // Un seul aller-retour. La valeur est un UUID vérifié juste au-dessus :
      // aucune interpolation de donnée utilisateur ici.
      await client.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true)`);
    } else {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    }
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
