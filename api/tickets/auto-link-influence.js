// POST /api/tickets/auto-link-influence
// Correctif 2026-09-15 (6e passage), demandé par Luc : lie automatiquement
// un profil "influence" à TOUS les tickets Instagram existants qui n'en ont
// pas encore (find-or-create par handle, voir lib/influence.js) — le
// rattrapage pour les conversations déjà en base. Les NOUVEAUX tickets
// Instagram sont désormais liés automatiquement dès leur création (voir le
// correctif du même jour dans api/tickets/sync-instagram.js) ; cet endpoint
// sert donc surtout une fois, pour repartir sur une base propre, mais peut
// être relancé à tout moment sans risque (idempotent : ne touche que les
// tickets encore non liés).
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { findOrCreateInfluenceRelation } = require('../../lib/influence');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const result = await withTenant(tenant.id, async (client) => {
    const { rows: tickets } = await client.query(
      `SELECT id, contact_handle FROM tickets
       WHERE tenant_id = $1 AND channel = 'instagram'
         AND influence_relation_id IS NULL
         AND contact_handle IS NOT NULL AND contact_handle <> ''`,
      [tenant.id]
    );

    let linked = 0;
    let skipped = 0;
    const details = [];

    for (const t of tickets) {
      const relationId = await findOrCreateInfluenceRelation(client, tenant.id, t.contact_handle, t.contact_handle);
      if (!relationId) {
        skipped += 1;
        continue;
      }
      await client.query(`UPDATE tickets SET influence_relation_id = $2, updated_at = now() WHERE id = $1`, [t.id, relationId]);
      linked += 1;
      details.push({ ticket_id: t.id, contact_handle: t.contact_handle, relation_id: relationId });
    }

    if (linked > 0) {
      await logAudit(client, tenant.id, {
        actor: 'manual',
        action: 'influence_bulk_auto_linked',
        entityType: 'ticket',
        entityId: null,
        details: { linked, skipped, tickets: details },
      });
    }

    return { linked, skipped, total_candidates: tickets.length };
  });

  sendJson(res, 200, result);
});
