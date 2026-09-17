// GET  /api/tickets/:id/gifting-order              résumé : éligibilité + commandes déjà passées
// GET  /api/tickets/:id/gifting-order?mode=proposal proposition pré-remplie par l'IA
//                                                    (produit, pointure, coordonnées, quota)
// POST /api/tickets/:id/gifting-order              crée la commande Shopify à 0 € (clic de Luc)
//
// Ajout 2026-09-16 (commande gifting influenceuse). Voir lib/gifting/orders.js
// pour les garde-fous : collaboration acceptée, stock, quota 5 paires par
// modèle/coloris sur une collection, pas de doublon, idempotence, 0 € vérifié.
// Seule route de l'appli qui écrit dans Shopify, et uniquement des commandes
// de gifting (aucun remboursement, annulation ou modification possible).
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { getGiftingSummary, buildGiftingProposal, createGiftingOrder } = require('../../../lib/gifting/orders');

module.exports = withTenantHandler(async (req, res, tenant) => {
  const ticketId = req.query.id;
  try {
    if (req.method === 'GET') {
      const data = req.query.mode === 'proposal'
        ? await buildGiftingProposal(tenant, ticketId)
        : await getGiftingSummary(tenant, ticketId);
      sendJson(res, 200, data);
      return;
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const actor = body.created_by ? String(body.created_by).trim().slice(0, 80) : null;
      const result = await createGiftingOrder(tenant, ticketId, body, actor);
      sendJson(res, result.replay ? 200 : 201, result);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.code || err.message, ...(err.extra || {}) });
      return;
    }
    throw err;
  }
});

module.exports.config = { maxDuration: 60 };
