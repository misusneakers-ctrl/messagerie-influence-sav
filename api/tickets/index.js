// GET  /api/tickets            liste/recherche des tickets de la marque résolue
// POST /api/tickets            création manuelle d'un ticket (ex. email SAV entrant)
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const { status, channel, category, q, include_archived, sort } = req.query || {};
    // Correctif 2026-09-15 (tri + date affichée dans la liste) : le tri se
    // faisait sur tickets.updated_at, une colonne posée par n'importe quelle
    // modification du ticket (changement de statut, de catégorie…) et, avant
    // le correctif côté sync-instagram.js, systématiquement écrasée à l'heure
    // du sondage pour CHAQUE conversation scannée — d'où des tickets
    // affichant tous la même heure, sans rapport avec le moment réel d'un
    // message. On calcule maintenant last_message_at à partir du vrai
    // dernier message du ticket (sent_at s'il existe — envoi réel côté
    // sortant —, sinon created_at) et on trie/affiche sur cette valeur-là.
    // `sort` (asc|desc, défaut desc = plus récent d'abord) est réglable
    // depuis le sélecteur ajouté dans l'appli.
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';
    const result = await withTenant(tenant.id, async (client) => {
      // tenant_id filtré explicitement ici : RLS ne protège pas cette requête
      // (rôle applicatif neondb_owner en BYPASSRLS, voir
      // TRANSMISSION-Messagerie-Influence-SAV.md, incident du 12/09/2026) —
      // sans ce filtre, cette route renvoyait les tickets de TOUTES les
      // marques mélangés, quelle que soit la marque demandée.
      // Colonnes préfixées "t." : ticket_messages porte elle aussi une
      // colonne tenant_id et une colonne status (celle du message :
      // draft/validated/sent/…), donc sans préfixe la requête devenait
      // ambiguë une fois la jointure ci-dessous ajoutée.
      const params = [tenant.id];
      const conditions = ['t.tenant_id = $1'];
      if (status) {
        params.push(status);
        conditions.push(`t.status = $${params.length}`);
      }
      if (channel) {
        params.push(channel);
        conditions.push(`t.channel = $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`t.category = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        conditions.push(`(t.contact_name ILIKE $${params.length} OR t.contact_handle ILIKE $${params.length} OR t.contact_email ILIKE $${params.length} OR t.related_order_number ILIKE $${params.length})`);
      }
      // Les tickets archivés sont exclus par défaut de la boîte ; les
      // afficher explicitement nécessite ?include_archived=1.
      if (!include_archived) {
        conditions.push('t.archived_at IS NULL');
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await client.query(
        `SELECT t.*, COALESCE(lm.last_message_at, t.updated_at) AS last_message_at
         FROM tickets t
         LEFT JOIN LATERAL (
           SELECT MAX(COALESCE(sent_at, created_at)) AS last_message_at
           FROM ticket_messages
           WHERE ticket_id = t.id
         ) lm ON true
         ${where}
         ORDER BY last_message_at ${sortDir} NULLS LAST
         LIMIT 200`,
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
      const { rows: catRows } = await client.query(
        "SELECT label, is_default FROM ticket_field_options WHERE field = 'category' ORDER BY sort_order"
      );
      const { rows: statusRows } = await client.query(
        "SELECT label, is_default FROM ticket_field_options WHERE field = 'status' ORDER BY sort_order"
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
