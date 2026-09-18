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
      // Correctif 2026-09-18 : le détail de l'erreur Gmail (code HTTP et
      // message de Google) n'était renvoyé qu'au navigateur. Résultat : « gmail
      // api error » à l'écran, et RIEN dans les journaux Vercel — impossible de
      // savoir si c'est un quota, un jeton périmé ou un message illisible.
      // Même leçon que le stock ce matin : ne jamais avaler une erreur.
      console.error('[gmail] synchro impossible :', err.code, '—', String(err.message || '').slice(0, 300));
      sendJson(res, 502, { error: err.code, detail: err.message });
      return;
    }
    throw err;
  }
});

module.exports.config = { maxDuration: 60 };
