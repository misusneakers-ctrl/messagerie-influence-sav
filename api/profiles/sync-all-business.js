// POST /api/profiles/sync-all-business
// Correctif 2026-09-15 (8e passage), demandé par Luc ("j'ai vu que tout le
// monde était lié sur Instagram, mais ça ne récupère pas les informations
// de tout le monde") : jusqu'ici, la synchro Business Discovery ne se
// faisait qu'un profil à la fois via le bouton "🔄 Synchroniser" dans le
// panneau — normal que les profils fraîchement liés en masse (bouton
// "🔗 Lier tous les profils Instagram") n'aient pas encore leurs
// followers/engagement/tags. Ce endpoint synchronise TOUS les profils liés
// à ce tenant en une fois.
//
// Concurrence volontairement basse (3 à la fois, contre 5 pour le sondage
// DM dans sync-instagram.js) : chaque profil déclenche un appel Business
// Discovery distinct côté Meta, et Luc peut avoir plusieurs dizaines de
// profils liés d'un coup après un premier rattrapage — mieux vaut rester
// prudent sur le rythme des appels plutôt que de risquer un throttling Meta
// qui ferait échouer tout le lot.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { syncOneInfluenceAccount, getBusinessDiscoveryCredential, SyncError } = require('../../lib/business-discovery');

const CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const cred = await getBusinessDiscoveryCredential(tenant.id);
  if (!cred) {
    sendJson(res, 400, {
      error: 'facebook_not_connected',
      message: 'Connecte d\'abord Facebook pour cette marque (bouton "Connecter Facebook").',
    });
    return;
  }

  const accounts = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT ia.id, ia.instagram_handle
       FROM tenant_influence_relations r
       JOIN influence_accounts ia ON ia.id = r.account_id
       WHERE r.tenant_id = $1 AND ia.instagram_handle IS NOT NULL AND ia.instagram_handle <> ''`,
      [tenant.id]
    );
    return rows;
  });

  if (accounts.length === 0) {
    sendJson(res, 200, { synced: 0, failed: 0, total: 0, errors: [] });
    return;
  }

  let synced = 0;
  const errors = [];
  await mapWithConcurrency(accounts, CONCURRENCY, async (acc) => {
    try {
      await syncOneInfluenceAccount(tenant.id, acc.id, cred);
      synced += 1;
    } catch (err) {
      errors.push({
        account_id: acc.id,
        instagram_handle: acc.instagram_handle,
        error: err instanceof SyncError ? err.code : 'unexpected_error',
        detail: (err && (err.detail || err.message)) || null,
      });
    }
  });

  sendJson(res, 200, { synced, failed: errors.length, total: accounts.length, errors });
});
