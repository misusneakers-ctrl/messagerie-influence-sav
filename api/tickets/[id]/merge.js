// GET  /api/tickets/:id/merge     fusions de ce ticket (conversations absorbées,
//                                  ou ticket cible si celui-ci a été fusionné)
// POST /api/tickets/:id/merge     { source_ticket_id, merged_by, evidence? }
//                                  → fusionne la conversation source DANS ce ticket
// POST /api/tickets/:id/merge     { undo_merge_id, undone_by }
//                                  → défait une fusion
//
// Ajout 2026-09-17 (enquête d'Alice), demandé par Luc : quand Alice retrouve
// une autre conversation du même client (ex. un e-mail et un DM Instagram),
// Luc peut la fusionner d'un clic. RIEN n'est supprimé :
// - les messages de la source sont DÉPLACÉS vers ce ticket (liste exacte des
//   identifiants conservée dans ticket_merges) ;
// - la source est archivée et marquée merged_into_ticket_id (les nouveaux
//   messages Instagram qui arriveraient sur elle sont redirigés ici, voir
//   api/tickets/sync-instagram.js et api/webhooks/instagram.js) ;
// - les champs vides de ce ticket (e-mail, nom, commande liée, profil
//   influence) sont complétés depuis la source, et notés pour pouvoir être
//   remis à vide si on défait la fusion ;
// - « Défaire » remet chaque message et chaque champ à sa place.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');
// La logique de fusion vit dans lib/ticket-merge.js depuis le 18/09 :
// elle est aussi appelée par la fusion automatique Instagram + e-mail.
const { listMerges, mergeTickets, undoMerge } = require('../../../lib/ticket-merge');

module.exports = withTenantHandler(async (req, res, tenant) => {
  const ticketId = String(req.query.id || '');
  try {
    if (req.method === 'GET') {
      const data = await withTenant(tenant.id, (client) => listMerges(client, tenant.id, ticketId));
      sendJson(res, 200, data);
      return;
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const data = await withTenant(tenant.id, (client) => (body.undo_merge_id ? undoMerge(client, tenant, ticketId, body) : mergeTickets(client, tenant, ticketId, body)));
      sendJson(res, 200, data);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.message, ...(err.extra || {}) });
      return;
    }
    if (err.code === '22P02') {
      sendJson(res, 400, { error: 'invalid_ticket_id' });
      return;
    }
    throw err;
  }
});
