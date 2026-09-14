// GET  /api/tickets            liste/recherche des tickets de la marque résolue
// POST /api/tickets            création manuelle d'un ticket (ex. email SAV entrant)
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const { status, channel, category, q, include_archived } = req.query || {};
    const result = await withTenant(tenant.id, async (client) => {
      // tenant_id filtré explicitement ici : RLS ne protège pas cette requête
      // (rôle applicatif neondb_owner en BYPASSRLS, voir
      // TRANSMISSION-Messagerie-Influence-SAV.md, incident du 12/09/2026) —
      // sans ce filtre, cette route renvoyait les tickets de TOUTES les
      // marques mélangés, quelle que soit la marque demandée.
      const params = [tenant.id];
      const conditions = ['tenant_id = $1'];
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (channel) {
        params.push(channel);
        conditions.push(`channel = $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        conditions.push(`(contact_name ILIKE $${params.length} OR contact_handle ILIKE $${params.length} OR contact_email ILIKE $${params.length} OR related_order_number ILIKE $${params.length})`);
      }
      // Les tickets archivés sont exclus par défaut de la boîte ; les
      // afficher explicitement nécessite ?include_archived=1.
      if (!include_archived) {
        conditions.push('archived_at IS NULL');
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await client.query(
        `SELECT * FROM tickets ${where} ORDER BY updated_at DESC LIMIT 200`,
        params
      );
      return rows;
    });
    sendJson(res, 200, { tickets: result });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.channel) {
      sendJson(res, 400, { error: 'channel_required' });
      return;
    }

    const ticket = await withTenant(tenant.id, async (client) => {
      // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté sur ces deux
      // requêtes. Sans lui, la création d'un ticket pouvait piocher un
      // statut/catégorie par défaut appartenant à une AUTRE marque (même
      // défaut que celui corrigé le 12/09 sur api/settings/options/index.js
      // — RLS ne protège pas ces requêtes, voir
      // TRANSMISSION-Messagerie-Influence-SAV.md).
      const { rows: catRows } = await client.query(
        "SELECT label, is_default FROM ticket_field_options WHERE tenant_id = $1 AND field = 'category' ORDER BY sort_order",
        [tenant.id]
      );
      const { rows: statusRows } = await client.query(
        "SELECT label, is_default FROM ticket_field_options WHERE tenant_id = $1 AND field = 'status' ORDER BY sort_order",
        [tenant.id]
      );
      const catLabels = catRows.map((r) => r.label);
      const statusLabels = statusRows.map((r) => r.label);
      const defaultCategory = (catRows.find((r) => r.is_default) || {}).label || catLabels[0] || 'Autre';
      const defaultStatus = (statusRows.find((r) => r.is_default) || {}).label || statusLabels[0] || 'À traiter';
      const category = catLabels.includes(body.category) ? body.category : defaultCategory;
      const status = statusLabels.includes(body.status) ? body.status : defaultStatus;

      const { rows } = await client.query(
        `INSERT INTO tickets
           (tenant_id, channel, category, status, contact_name, contact_handle, contact_email,
            related_order_number, external_thread_id, summary, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          tenant.id, body.channel, category, status,
          body.contact_name || null, body.contact_handle || null, body.contact_email || null,
          body.related_order_number || null, body.external_thread_id || null,
          body.summary || null, body.assigned_to || null,
        ]
      );
      const ticketRow = rows[0];
      await logAudit(client, tenant.id, {
        actor: body.actor || 'manual',
        action: 'ticket_created',
        entityType: 'ticket',
        entityId: ticketRow.id,
        details: { channel: body.channel, category },
      });
      return ticketRow;
    });
    sendJson(res, 201, { ticket });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
