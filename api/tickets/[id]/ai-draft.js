// POST /api/tickets/:id/ai-draft
// Ajout 2026-09-16 (brouillons IA) : bouton « ✨ Préparer une réponse ».
// Lance l'analyse IA de cette conversation et, si une réponse est utile,
// crée un brouillon "draft" signé du prénom de la marque (remplace un
// éventuel brouillon IA précédent encore non validé — jamais un brouillon
// écrit ou validé par Luc).
//
// Corps JSON : { instruction?: string, dry_run?: boolean }
// - instruction : consigne libre de Luc (« refuse poliment », « propose
//   plutôt l'Elisabeth Silver »...). Avec une consigne, l'IA peut rédiger
//   même sur une demande spontanée sans décision enregistrée.
// - dry_run : analyse et renvoie le texte proposé SANS rien écrire en base.
// Ne fait jamais d'envoi.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { analyzeTicket } = require('../../../lib/ai/assistant');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const ticketId = req.query.id;
  const body = req.body || {};
  const instruction = body.instruction ? String(body.instruction).trim().slice(0, 800) : null;

  try {
    const result = await analyzeTicket(tenant, ticketId, {
      mode: 'manual',
      instruction,
      actor: body.requested_by ? String(body.requested_by).slice(0, 80) : 'ia (demande manuelle)',
      dryRun: !!body.dry_run,
    });
    sendJson(res, 200, result);
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.code || err.message });
      return;
    }
    if (err.code === 'ai_api_error' || err.code === 'ai_timeout' || err.code === 'ai_no_final_result') {
      sendJson(res, 502, { error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

// Durée max de la fonction sur Vercel : un appel IA peut prendre 10 à 40 s.
module.exports.config = { maxDuration: 120 };
