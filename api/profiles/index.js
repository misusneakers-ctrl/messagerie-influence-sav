// GET  /api/profiles     recherche des profils influence de la marque résolue
//                          (identité partagée + relation propre à la marque)
// POST /api/profiles     crée une relation pour la marque, en réutilisant un
//                          influence_accounts existant si le handle correspond
//                          déjà (modèle "agence" : la personne n'est jamais dupliquée)
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant, withoutTenant } = require('../../lib/db');
const { recordsForRelations } = require('../../lib/campaigns');
const { logAudit } = require('../../lib/audit');

function normalizeHandle(handle) {
  if (!handle) return null;
  return handle.trim().replace(/^@/, '').toLowerCase();
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const { q, min_score, tag } = req.query || {};
    const relations = await withTenant(tenant.id, async (client) => {
      // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté. Sans lui,
      // cette route renvoyait les relations influence de TOUTES les marques
      // mélangées (RLS ne protège pas cette requête — voir
      // TRANSMISSION-Messagerie-Influence-SAV.md, incident du 12/09/2026).
      const params = [tenant.id];
      const conditions = ['r.tenant_id = $1'];
      let joinTag = '';
      if (tag) {
        joinTag = 'JOIN relation_tags rt ON rt.relation_id = r.id JOIN tags t ON t.id = rt.tag_id';
        params.push(tag);
        conditions.push(`t.label = $${params.length}`);
      }
      if (min_score) {
        params.push(Number(min_score));
        conditions.push(`r.score_total >= $${params.length}`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await client.query(
        `SELECT r.* FROM tenant_influence_relations r ${joinTag} ${where} ORDER BY r.updated_at DESC LIMIT 200`,
        params
      );
      return rows;
    });

    if (relations.length === 0) {
      sendJson(res, 200, { profiles: [] });
      return;
    }

    // L'identité (influence_accounts) est hors RLS par nature (partagée entre marques) :
    // lecture via withoutTenant(), en ne récupérant que les comptes déjà liés
    // à une relation appartenant à ce tenant (jamais une recherche libre transverse ici).
    const accountIds = relations.map((r) => r.account_id);
    const accounts = await withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM influence_accounts WHERE id = ANY($1::uuid[])
         ${q ? "AND (display_name ILIKE $2 OR instagram_handle ILIKE $2 OR tiktok_handle ILIKE $2)" : ''}`,
        q ? [accountIds, `%${q}%`] : [accountIds]
      );
      return rows;
    });
    const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));

    // Ajout 2026-09-18 : bilan campagnes (paires offertes / publications) joint
    // à chaque profil. Une seule requête agrégée pour toute la liste — c'est
    // ce chiffre qui sert à écarter celles qui ne publient jamais.
    let records = {};
    try {
      records = await withTenant(tenant.id, (client) => (
        recordsForRelations(client, tenant.id, relations.map((r) => r.id))
      ));
    } catch (err) {
      console.error('[campagnes] bilan indisponible :', String(err.message || err).slice(0, 200));
    }

    const profiles = relations
      .filter((r) => accountsById[r.account_id])
      .map((r) => ({ account: accountsById[r.account_id], relation: r, record: records[r.id] || null }));

    sendJson(res, 200, { profiles });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const igHandle = normalizeHandle(body.instagram_handle);
    const tiktokHandle = normalizeHandle(body.tiktok_handle);

    if (!body.display_name && !igHandle && !tiktokHandle) {
      sendJson(res, 400, { error: 'display_name_or_handle_required' });
      return;
    }

    // Étape 1 (hors tenant) : chercher un compte existant par handle, sinon en créer un.
    const account = await withoutTenant(async (client) => {
      if (igHandle) {
        const { rows } = await client.query(
          'SELECT * FROM influence_accounts WHERE lower(instagram_handle) = $1',
          [igHandle]
        );
        if (rows[0]) return rows[0];
      }
      if (tiktokHandle) {
        const { rows } = await client.query(
          'SELECT * FROM influence_accounts WHERE lower(tiktok_handle) = $1',
          [tiktokHandle]
        );
        if (rows[0]) return rows[0];
      }
      const { rows } = await client.query(
        `INSERT INTO influence_accounts
           (display_name, instagram_handle, tiktok_handle, instagram_url, tiktok_url, email,
            city, country, follower_count, recent_views_observed, engagement_observed,
            editorial_universe, visible_brands_collabs, evidence_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          body.display_name || igHandle || tiktokHandle,
          igHandle, tiktokHandle, body.instagram_url || null, body.tiktok_url || null,
          body.email || null, body.city || null, body.country || null,
          body.follower_count ?? null, body.recent_views_observed ?? null, body.engagement_observed ?? null,
          body.editorial_universe || null, body.visible_brands_collabs || null, body.evidence_notes || null,
        ]
      );
      return rows[0];
    });

    // Étape 2 (dans le tenant) : créer ou réutiliser la relation pour cette marque.
    const relation = await withTenant(tenant.id, async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM tenant_influence_relations WHERE tenant_id = $1 AND account_id = $2',
        [tenant.id, account.id]
      );
      if (existing[0]) return existing[0];

      const { rows } = await client.query(
        `INSERT INTO tenant_influence_relations
           (tenant_id, account_id, relationship_status, contact_source, owner)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [tenant.id, account.id, body.relationship_status || 'nouveau', body.contact_source || null, body.owner || null]
      );
      const relationRow = rows[0];
      await logAudit(client, tenant.id, {
        actor: body.actor || 'manual',
        action: 'influence_relation_created',
        entityType: 'tenant_influence_relation',
        entityId: relationRow.id,
        details: { account_id: account.id, reused_existing_account: true },
      });
      return relationRow;
    });

    sendJson(res, 201, { account, relation });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
