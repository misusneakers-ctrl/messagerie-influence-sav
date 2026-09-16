// POST /api/ai/process
// Ajout 2026-09-16 (brouillons IA). Analyse par l'IA les conversations en
// attente de la marque résolue, par petits lots (le front rappelle cette
// route tant que `remaining` > 0, avec une barre de progression).
//
// Corps JSON : { mode: 'auto' | 'classify' }
// - 'auto'     : conversations dont le dernier message est un message ENTRANT
//                de moins de 24 h pas encore analysé → analyse + brouillon
//                (Influence uniquement). Appelé automatiquement après
//                « Actualiser Instagram ».
// - 'classify' : conversations jamais analysées (tout l'historique) →
//                analyse et reclassement uniquement, JAMAIS de brouillon.
//
// Ne fait aucun envoi : au plus des brouillons "draft" à valider par Luc.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { processPending, loadAiSettings } = require('../../lib/ai/assistant');
const { isConfigured } = require('../../lib/ai/anthropic');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!isConfigured()) {
    sendJson(res, 503, { error: 'ai_not_configured', message: 'Variable ANTHROPIC_API_KEY absente sur Vercel.' });
    return;
  }
  const body = req.body || {};
  const mode = body.mode === 'classify' ? 'classify' : 'auto';

  const settings = await withTenant(tenant.id, (client) => loadAiSettings(client, tenant));
  if (!settings.enabled) {
    sendJson(res, 200, { mode, disabled: true, processed: 0, remaining: 0, drafts_created: 0, decisions_required: 0, errors: [] });
    return;
  }

  try {
    const result = await processPending(tenant, { mode });
    sendJson(res, 200, result);
  } catch (err) {
    if (err.httpStatus) {
      sendJson(res, err.httpStatus, { error: err.code || err.message });
      return;
    }
    throw err;
  }
});

// Durée max de la fonction sur Vercel : un appel IA peut prendre 10 à 40 s.
module.exports.config = { maxDuration: 120 };
