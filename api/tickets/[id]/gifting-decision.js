// POST /api/tickets/:id/gifting-decision
// Ajout 2026-09-16 (brouillons IA) : boutons « ✅ Accepter » / « ❌ Refuser »
// sur une demande de collaboration spontanée. Enregistre la décision de Luc
// sur le ticket ET sur la relation influence de cette marque (une future
// conversation avec la même personne la retrouve), puis — sauf
// generate_draft: false — demande à l'IA le brouillon correspondant
// (suite du parcours gifting si acceptée, refus poli si refusée).
//
// Corps JSON : { decision: 'approved' | 'declined' | null, decided_by: string,
//               generate_draft?: boolean (défaut true), instruction?: string }
// decision: null efface la décision. Ne fait jamais d'envoi.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { recordGiftingDecision, analyzeTicket } = require('../../../lib/ai/assistant');
const { isConfigured } = require('../../../lib/ai/anthropic');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const ticketId = req.query.id;
  const body = req.body || {};
  if (!['approved', 'declined', null].includes(body.decision)) {
    sendJson(res, 400, { error: 'decision_must_be_approved_declined_or_null' });
    return;
  }
  if (body.decision && !body.decided_by) {
    sendJson(res, 400, { error: 'decided_by_required' });
    return;
  }

  try {
    const ticket = await recordGiftingDecision(tenant, ticketId, {
      decision: body.decision,
      decidedBy: body.decided_by ? String(body.decided_by).slice(0, 80) : null,
    });

    let ai = null;
    let aiError = null;
    if (body.decision && body.generate_draft !== false) {
      if (!isConfigured()) {
        aiError = 'ai_not_configured';
      } else {
        const instruction = body.instruction ? String(body.instruction).trim().slice(0, 800) : null;
        try {
          ai = await analyzeTicket(tenant, ticketId, { mode: 'manual', instruction, actor: body.decided_by });
        } catch (err) {
          // La décision est enregistrée même si l'IA échoue : Luc peut
          // relancer le brouillon avec le bouton « ✨ Préparer une réponse ».
          aiError = err.code || err.message;
        }
      }
    }
    sendJson(res, 200, { ticket, ai, ai_error: aiError });
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.message });
      return;
    }
    throw err;
  }
});

// Durée max de la fonction sur Vercel : un appel IA peut prendre 10 à 40 s.
module.exports.config = { maxDuration: 300 };
