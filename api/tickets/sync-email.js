// POST /api/tickets/sync-email
// Ajout 2026-09-17 : importe les nouveaux e-mails de la boîte SAV connectée
// (compte Hello) en tickets/messages — voir lib/channels/email-sync.js.
// Lancé par le bouton « Actualiser » de la messagerie (avec Instagram).
// Strictement en lecture côté Gmail ; ne crée jamais de brouillon ni d'envoi
// (l'analyse IA éventuelle est lancée ensuite par /api/ai/process).
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { syncEmailInbox } = require('../../lib/channels/email-sync');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  try {
    const summary = await syncEmailInbox(tenant, { maxMessages: 40, timeBudgetMs: 45000 });
    sendJson(res, 200, summary);
  } catch (err) {
    if (err.code === 'gmail_not_connected' || err.code === 'gmail_app_not_configured') {
      sendJson(res, 409, { error: err.code });
      return;
    }
    if (err.code === 'gmail_token_refresh_failed' || err.code === 'gmail_api_error') {
      sendJson(res, 502, { error: err.code, detail: err.message });
      return;
    }
    throw err;
  }
});

module.exports.config = { maxDuration: 60 };
