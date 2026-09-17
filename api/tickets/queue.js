// GET /api/tickets/queue
// Vue de traitement en lot ("File de validation") : liste, en lecture seule,
// tous les messages sortants encore en brouillon ("draft"), prêts à être
// validés puis envoyés. Alimente les deux onglets Messagerie / Influence de
// la file de validation côté front — ne modifie jamais rien.
//
// Ajout 2026-09-16 (brouillons IA) : chaque ligne indique aussi si le
// brouillon a été rédigé par l'IA (ai_generated), avec ses alertes pour Luc
// (ai_alerts : client mécontent, stock à vérifier, envoi à préparer...), sa
// justification (ai_rationale), le résumé de la conversation (ai_summary) et
// les coordonnées d'envoi reçues (shipping_details) quand il y en a.
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
         t.influence_relation_id, t.ai_analysis,
         tm.id AS message_id, tm.body AS message_body, tm.created_at AS message_created_at,
         tm.ai_generated, tm.ai_meta, tm.channel AS message_channel,
         li.created_at AS last_inbound_at, li.body AS last_inbound_body, li.channel AS last_inbound_channel,
         lig.created_at AS last_instagram_inbound_at,
         rel.score_total, rel.relationship_status
       FROM tickets t
       JOIN ticket_messages tm
         ON tm.ticket_id = t.id AND tm.direction = 'outbound' AND tm.status = 'draft' AND tm.tenant_id = $1
       LEFT JOIN LATERAL (
         SELECT created_at, body, channel FROM ticket_messages
         WHERE ticket_id = t.id AND direction = 'inbound' AND tenant_id = $1
         ORDER BY created_at DESC LIMIT 1
       ) li ON true
       LEFT JOIN LATERAL (
         SELECT created_at FROM ticket_messages
         WHERE ticket_id = t.id AND direction = 'inbound' AND tenant_id = $1 AND COALESCE(channel, t.channel) = 'instagram'
         ORDER BY created_at DESC LIMIT 1
       ) lig ON true
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
    // Correctif 2026-09-17 (canal e-mail) : canal de RÉPONSE = celui choisi
    // pour le brouillon, sinon celui du dernier message reçu (voir
    // lib/channels/dispatch.js).
    const replyChannel = r.message_channel || r.last_inbound_channel || r.channel;
    if (replyChannel === 'instagram') {
      withinWindow = instagram.isWithinResponseWindow(r.last_instagram_inbound_at || r.last_inbound_at);
      if (!withinWindow) alerts.push('hors_fenetre_24h');
    } else if (replyChannel === 'email') {
      withinWindow = true;
    } else {
      // Seul le canal Instagram sait effectivement envoyer aujourd'hui (voir
      // TRANSMISSION-Messagerie-Influence-SAV.md, "reste à faire" — email SAV
      // non câblé). Un brouillon sur un autre canal reste consultable mais
      // n'est jamais traitable depuis cette vue.
      alerts.push('canal_non_implemente');
    }
    const aiMeta = r.ai_meta || {};
    const analysis = r.ai_analysis || {};
    // Alertes IA : celles posées au moment de la rédaction du brouillon (on
    // retire hors_fenetre_24h, déjà calculée ci-dessus en temps réel).
    const aiAlerts = r.ai_generated
      ? (Array.isArray(aiMeta.alerts) ? aiMeta.alerts : []).filter((a) => a && a.code !== 'hors_fenetre_24h')
      : [];
    return {
      ticket_id: r.ticket_id,
      channel: replyChannel,
      ticket_channel: r.channel,
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
      sendable: (replyChannel === 'instagram' || replyChannel === 'email') && withinWindow === true,
      alerts,
      ai_generated: !!r.ai_generated,
      ai_alerts: aiAlerts,
      ai_rationale: r.ai_generated ? aiMeta.rationale || null : null,
      ai_summary: analysis.summary || null,
      ai_sentiment: analysis.sentiment || null,
      ai_register: analysis.register || null,
      shipping_details: r.ai_generated ? aiMeta.shipping_details || null : null,
    };
  });

  sendJson(res, 200, { items });
});
