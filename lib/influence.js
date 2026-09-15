// lib/influence.js
// Correctif 2026-09-15 (6e passage), demandé par Luc : lier automatiquement
// un profil "influence" (influence_accounts + tenant_influence_relations) à
// partir du handle Instagram d'un contact, au lieu d'exiger une recherche/
// création manuelle depuis chaque ticket (bouton "Lier un profil influence").
//
// find-or-create des DEUX côtés :
// 1. influence_accounts est une table PARTAGÉE entre tenants (pas de
//    tenant_id dessus, voir withoutTenant ailleurs dans le code) — un même
//    compte Instagram peut avoir contacté BBP et Misü séparément, donc on
//    réutilise la ligne existante si le handle correspond déjà (index
//    unique insensible à la casse influence_accounts_ig_handle_idx), sinon
//    on la crée.
// 2. tenant_influence_relations est le lien PROPRE À CE TENANT vers ce
//    compte partagé — on réutilise la relation existante si elle existe
//    déjà pour (tenant, account), sinon on la crée.
//
// Cette fonction est utilisée à deux endroits : automatiquement à la
// création d'un nouveau ticket Instagram (api/profiles/sync-instagram.js),
// et pour le bouton "Lier tous les profils Instagram" qui rattrape les
// tickets existants (api/tickets/auto-link-influence.js).
async function findOrCreateInfluenceRelation(client, tenantId, handle, displayName) {
  const cleanHandle = String(handle || '').trim().replace(/^@/, '');
  if (!cleanHandle) return null;

  const { rows: accRows } = await client.query(
    `SELECT id FROM influence_accounts WHERE lower(instagram_handle) = lower($1) LIMIT 1`,
    [cleanHandle]
  );
  let accountId;
  if (accRows[0]) {
    accountId = accRows[0].id;
  } else {
    const { rows: newAcc } = await client.query(
      `INSERT INTO influence_accounts (display_name, instagram_handle, instagram_url)
       VALUES ($1, $2, $3) RETURNING id`,
      [displayName || cleanHandle, cleanHandle, `https://instagram.com/${cleanHandle}`]
    );
    accountId = newAcc[0].id;
  }

  const { rows: relRows } = await client.query(
    `SELECT id FROM tenant_influence_relations WHERE tenant_id = $1 AND account_id = $2 LIMIT 1`,
    [tenantId, accountId]
  );
  if (relRows[0]) {
    return relRows[0].id;
  }
  const { rows: newRel } = await client.query(
    `INSERT INTO tenant_influence_relations (tenant_id, account_id, contact_source)
     VALUES ($1, $2, 'instagram_auto_link') RETURNING id`,
    [tenantId, accountId]
  );
  return newRel[0].id;
}

module.exports = { findOrCreateInfluenceRelation };
