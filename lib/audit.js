// Écriture dans le journal d'audit. Toujours appelé à l'intérieur d'un
// withTenant() déjà ouvert, avec le même client, pour rester dans la même
// transaction que l'action journalisée.

async function logAudit(client, tenantId, { actor, action, entityType, entityId, details }) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, actor || 'system', action, entityType, entityId || null, details ? JSON.stringify(details) : '{}']
  );
}

module.exports = { logAudit };
