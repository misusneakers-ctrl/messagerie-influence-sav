// lib/ticket-merge.js
// Extrait le 2026-09-18 de api/tickets/[id]/merge.js, sans changer une ligne
// de la logique : la fusion doit pouvoir être déclenchée ailleurs que par un
// clic de Luc. Elle l'est désormais aussi automatiquement, quand on découvre
// que la cliente qui écrit en DM a aussi écrit par e-mail
// (voir lib/conversation-merge.js) — décision de Luc du 18/09 : « il faut
// faire merger les discussions dans la timeline de discussion ».
//
// Le fichier d'API d'origine ne contient plus que le routage HTTP.

const { withTenant } = require('./db');
const { logAudit } = require('./audit');

const FILLABLE_FIELDS = ['contact_email', 'contact_name', 'contact_handle', 'related_order_number', 'influence_relation_id'];

function httpError(status, code, extra) {
  const err = new Error(code);
  err.httpStatus = status;
  err.extra = extra;
  return err;
}

async function listMerges(client, tenantId, ticketId) {
  const { rows: absorbed } = await client.query(
    `SELECT m.id, m.source_ticket_id, m.merged_by, m.merged_at, cardinality(m.message_ids) AS messages,
            s.channel, s.contact_name, s.contact_handle, s.contact_email, s.created_at AS source_created_at
     FROM ticket_merges m
     JOIN tickets s ON s.id = m.source_ticket_id AND s.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1 AND m.target_ticket_id = $2 AND m.undone_at IS NULL
     ORDER BY m.merged_at DESC`,
    [tenantId, ticketId]
  );
  const { rows: into } = await client.query(
    `SELECT t.merged_into_ticket_id AS target_ticket_id, c.contact_name, c.contact_handle, c.channel
     FROM tickets t LEFT JOIN tickets c ON c.id = t.merged_into_ticket_id AND c.tenant_id = t.tenant_id
     WHERE t.tenant_id = $1 AND t.id = $2 AND t.merged_into_ticket_id IS NOT NULL`,
    [tenantId, ticketId]
  );
  return { absorbed, merged_into: into[0] || null };
}

async function mergeTickets(client, tenant, targetId, body) {
  const sourceId = String(body.source_ticket_id || '');
  const mergedBy = String(body.merged_by || '').trim().slice(0, 80);
  if (!sourceId) throw httpError(400, 'source_ticket_id_required');
  if (!mergedBy) throw httpError(400, 'merged_by_required');
  if (sourceId === targetId) throw httpError(400, 'cannot_merge_into_itself');

  // Verrou dans un ordre stable pour éviter un interblocage si deux fusions
  // croisées sont lancées en même temps.
  const { rows } = await client.query(
    `SELECT * FROM tickets WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [tenant.id, [targetId, sourceId]]
  );
  const target = rows.find((r) => r.id === targetId);
  const source = rows.find((r) => r.id === sourceId);
  if (!target) throw httpError(404, 'ticket_not_found');
  if (!source) throw httpError(404, 'source_ticket_not_found');
  if (target.merged_into_ticket_id) throw httpError(409, 'target_already_merged', { merged_into_ticket_id: target.merged_into_ticket_id });
  if (source.merged_into_ticket_id) throw httpError(409, 'source_already_merged', { merged_into_ticket_id: source.merged_into_ticket_id });

  // Chaque message garde son canal d'origine (pour répondre par le bon canal).
  await client.query(
    `UPDATE ticket_messages SET channel = $1 WHERE tenant_id = $2 AND ticket_id = $3 AND channel IS NULL AND direction = 'inbound'`,
    [source.channel, tenant.id, sourceId]
  );
  const { rows: movedMessages } = await client.query(
    `UPDATE ticket_messages SET ticket_id = $1 WHERE tenant_id = $2 AND ticket_id = $3 RETURNING id`,
    [targetId, tenant.id, sourceId]
  );
  const { rows: movedGifting } = await client.query(
    `UPDATE gifting_orders SET ticket_id = $1 WHERE tenant_id = $2 AND ticket_id = $3 RETURNING id`,
    [targetId, tenant.id, sourceId]
  );

  const filled = {};
  const sets = [];
  const params = [];
  for (const field of FILLABLE_FIELDS) {
    if ((target[field] === null || target[field] === '') && source[field] !== null && source[field] !== '') {
      // Le profil Instagram d'une autre conversation Instagram ne remplace
      // pas le pseudo de celle-ci (c'est ce fil qui sert à répondre).
      if (field === 'contact_handle' && target.channel === 'instagram') continue;
      filled[field] = source[field];
      params.push(source[field]);
      sets.push(`${field} = $${params.length}`);
    }
  }
  params.push(targetId, tenant.id);
  await client.query(
    `UPDATE tickets SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now()
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
    params
  );
  await client.query(
    `UPDATE tickets SET merged_into_ticket_id = $1, archived_at = COALESCE(archived_at, now()), updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [targetId, sourceId, tenant.id]
  );

  const { rows: mergeRows } = await client.query(
    `INSERT INTO ticket_merges (tenant_id, target_ticket_id, source_ticket_id, message_ids, gifting_order_ids,
                                target_fields_filled, source_was_archived, merged_by, evidence)
     VALUES ($1, $2, $3, $4::uuid[], $5::uuid[], $6, $7, $8, $9) RETURNING *`,
    [tenant.id, targetId, sourceId, movedMessages.map((m) => m.id), movedGifting.map((g) => g.id),
      JSON.stringify(filled), !!source.archived_at, mergedBy, body.evidence ? JSON.stringify(body.evidence).slice(0, 4000) : null]
  );

  const details = { merge_id: mergeRows[0].id, target_ticket_id: targetId, source_ticket_id: sourceId, messages_moved: movedMessages.length, gifting_orders_moved: movedGifting.length, fields_filled: Object.keys(filled) };
  await logAudit(client, tenant.id, { actor: mergedBy, action: 'ticket_merged', entityType: 'ticket', entityId: targetId, details });
  await logAudit(client, tenant.id, { actor: mergedBy, action: 'ticket_merged_into', entityType: 'ticket', entityId: sourceId, details });
  return { merge: mergeRows[0], ...details };
}

async function undoMerge(client, tenant, targetId, body) {
  const undoneBy = String(body.undone_by || '').trim().slice(0, 80);
  if (!undoneBy) throw httpError(400, 'undone_by_required');
  const { rows } = await client.query(
    `SELECT * FROM ticket_merges WHERE id = $1 AND tenant_id = $2 AND target_ticket_id = $3 FOR UPDATE`,
    [body.undo_merge_id, tenant.id, targetId]
  );
  const merge = rows[0];
  if (!merge) throw httpError(404, 'merge_not_found');
  if (merge.undone_at) throw httpError(409, 'merge_already_undone');

  const { rowCount: messagesBack } = await client.query(
    `UPDATE ticket_messages SET ticket_id = $1 WHERE tenant_id = $2 AND ticket_id = $3 AND id = ANY($4::uuid[])`,
    [merge.source_ticket_id, tenant.id, targetId, merge.message_ids]
  );
  await client.query(
    `UPDATE gifting_orders SET ticket_id = $1 WHERE tenant_id = $2 AND ticket_id = $3 AND id = ANY($4::uuid[])`,
    [merge.source_ticket_id, tenant.id, targetId, merge.gifting_order_ids]
  );
  // Champs complétés par la fusion : remis à vide seulement s'ils n'ont pas
  // été modifiés depuis.
  const filled = merge.target_fields_filled || {};
  for (const [field, value] of Object.entries(filled)) {
    if (!FILLABLE_FIELDS.includes(field)) continue;
    await client.query(
      `UPDATE tickets SET ${field} = NULL WHERE id = $1 AND tenant_id = $2 AND ${field}::text = $3`,
      [targetId, tenant.id, String(value)]
    );
  }
  await client.query(
    `UPDATE tickets SET merged_into_ticket_id = NULL, archived_at = CASE WHEN $1 THEN archived_at ELSE NULL END, updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [merge.source_was_archived, merge.source_ticket_id, tenant.id]
  );
  await client.query(
    `UPDATE ticket_merges SET undone_at = now(), undone_by = $1 WHERE id = $2 AND tenant_id = $3`,
    [undoneBy, merge.id, tenant.id]
  );
  const details = { merge_id: merge.id, target_ticket_id: targetId, source_ticket_id: merge.source_ticket_id, messages_moved_back: messagesBack };
  await logAudit(client, tenant.id, { actor: undoneBy, action: 'ticket_merge_undone', entityType: 'ticket', entityId: targetId, details });
  return details;
}

module.exports = { httpError, listMerges, mergeTickets, undoMerge, FILLABLE_FIELDS };
