// GET /api/tickets/queue
// Vue de traitement en lot ("File de validation") : liste, en lecture seule,
// tous les messages sortants encore en brouillon ("draft"), prêts à être
// validés puis envoyés. Alimente les deux onglets Messagerie / Influence de
// la file de validation côté front — ne modifie jamais rien.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const instagram = require('../../lib/channels/instagram');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const rows = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté sur t.
      // Sans lui, cette vue (la "File de validation") affichait les
      // brouillons sortants des DEUX marques mélangés — fuite cross-tenant
      // en lecture, déclenchable simplement en ouvrant la page (RLS ne
      // protège pas cette requête, rôle applicatif en BYPASSRLS).
      `SELECT
         t.id AS ticket_id, t.channel, t.category, t.status AS ticket_status,
         t.contact_name, t.contact_handle, t.contact_email, t.related_order_number,
         t.influence_relation_id,
         tm.id AS message_id, tm.body AS message_body, tm.created_at AS message_created_at,
         li.created_at AS last_inbound_at, li.body AS last_inbound_body,
         rel.score_total, rel.relationship_status
       FROM tickets t
       JOIN ticket_messages tm
         ON tm.ticket_id = t.id AND tm.direction = 'outbound' AND tm.status = 'draft' AND tm.tenant_id = $1
       LEFT JOIN LATERAL (
         SELECT created_at, body FROM ticket_messages
         WHERE ticket_id = t.id AND direction = 'inbound' AND tenant_id = $1
         ORDER BY created_at DESC LIMIT 1
       ) li ON true
       LEFT JOIN tenant_influence_relations rel ON rel.id = t.influence_relation_id AND rel.tenant_id = $1
       WHERE t.tenant_id = $1
       ORDER BY tm.created_at ASC`,
      [tenant.id]
    );
    return rows;
  });

  const items = rows.map((r) => {
    const alerts = [];
    let withinWindow = null;
    if (r.channel === 'instagram') {
      withinWindow = instagram.isWithinResponseWindow(r.last_inbound_at);
      if (!withinWindow) alerts.push('hors_fenetre_24h');
    } else {
      // Seul le canal Instagram sait effectivement envoyer aujourd'hui (voir
      // TRANSMISSION-Messagerie-Influence-SAV.md, "reste à faire" — email SAV
      // non câblé). Un brouillon sur un autre canal reste consultable mais
      // n'est jamais traitable depuis cette vue.
      alerts.push('canal_non_implemente');
    }
    return {
      ticket_id: r.ticket_id,
      channel: r.channel,
      category: r.category,
      group: r.category === 'Influence' ? 'influence' : 'messagerie',
      ticket_status: r.ticket_status,
      contact_name: r.contact_name,
      contact_handle: r.contact_handle,
      contact_email: r.contact_email,
      related_order_number: r.related_order_number,
      message_id: r.message_id,
      message_body: r.message_body,
      message_created_at: r.message_created_at,
      last_inbound_at: r.last_inbound_at,
      last_inbound_body: r.last_inbound_body,
      relationship_status: r.relationship_status,
      score_total: r.score_total,
      within_response_window: withinWindow,
      sendable: r.channel === 'instagram' && withinWindow === true,
      alerts,
    };
  });

  sendJson(res, 200, { items });
});
