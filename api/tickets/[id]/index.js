// GET   /api/tickets/:id            détail d'un ticket
// PATCH /api/tickets/:id            met à jour un ticket : statut, catégorie,
//                                     assignation, résumé, lien vers un profil
//                                     influence (tenant_influence_relations),
//                                     ou les infos de contact/commande liée.
// Ne touche jamais aux messages (voir messages.js) ni au workflow d'envoi.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');
const { logAudit } = require('../../../lib/audit');

const VALID_STATUSES = ['a_traiter', 'en_attente_client', 'en_attente_interne', 'a_valider', 'resolu', 'erreur'];
const VALID_CATEGORIES = ['Influence', 'SAV', 'Partenariat', 'Presse', 'B2B', 'Commande', 'Livraison', 'Retour', 'Paiement', 'Autre'];

const PATCHABLE_FIELDS = [
  'category',
  'status',
  'assigned_to',
  'summary',
  'influence_relation_id',
  'related_order_number',
  'contact_name',
  'contact_handle',
  'contact_email',
];

module.exports = withTenantHandler(async (req, res, tenant) => {
  const ticketId = req.query.id;

  if (req.method === 'GET') {
    const ticket = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
      return rows[0] || null;
    });
    if (!ticket) {
      sendJson(res, 404, { error: 'ticket_not_found' });
      return;
    }
    sendJson(res, 200, { ticket });
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};

    if (body.category !== undefined && !VALID_CATEGORIES.includes(body.category)) {
      sendJson(res, 400, { error: 'invalid_category' });
      return;
    }
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
      sendJson(res, 400, { error: 'invalid_status' });
      return;
    }

    const updates = [];
    const params = [];
    for (const field of PATCHABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        params.push(body[field] === '' ? null : body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (updates.length === 0) {
      sendJson(res, 400, { error: 'no_fields_to_update' });
      return;
    }

    try {
      const ticket = await withTenant(tenant.id, async (client) => {
        params.push(ticketId);
        const { rows } = await client.query(
          `UPDATE tickets SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
          params
        );
        const ticketRow = rows[0];
        if (!ticketRow) {
          const err = new Error('ticket_not_found');
          err.httpStatus = 404;
          throw err;
        }
        await logAudit(client, tenant.id, {
          actor: body.actor || 'manual',
          action: 'ticket_updated',
          entityType: 'ticket',
          entityId: ticketRow.id,
          details: { fields: Object.keys(body).filter((k) => PATCHABLE_FIELDS.includes(k)) },
        });
        return ticketRow;
      });
      sendJson(res, 200, { ticket });
    } catch (err) {
      if (err.httpStatus) {
        sendJson(res, err.httpStatus, { error: err.message });
        return;
      }
      // Violation de clé étrangère : ex. influence_relation_id qui ne
      // correspond à aucune ligne tenant_influence_relations existante.
      if (err.code === '23503') {
        sendJson(res, 400, { error: 'invalid_reference', detail: err.detail });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
