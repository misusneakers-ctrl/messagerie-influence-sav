// POST /api/profiles/[id]/sync-business
// Va chercher automatiquement, via l'API Business Discovery de Meta, les
// infos publiques d'un influenceur tiers à partir de son handle Instagram
// déjà enregistré (influence_accounts.instagram_handle) : photo de profil,
// nombre de followers, taux d'engagement estimé, tags fréquents et comptes
// mentionnés déduits des derniers posts. Nécessite que la marque (tenant)
// ait connecté Facebook Login for Business au préalable (bouton "🔗
// Connecter Facebook", credential tenant_credentials de type
// 'meta_business_discovery' posé par api/profiles/facebook-callback.js).
//
// Limites assumées, à connaître avant de lire les chiffres obtenus :
// - Business Discovery ne renvoie que les ~25 posts les plus RÉCENTS du
//   compte, sans filtre par date : on ne peut pas garantir "les posts des
//   90 derniers jours" si le compte publie peu souvent, on prend les 12
//   plus récents disponibles, point.
// - Le "taux d'engagement" est calculé ici comme
//   moyenne((likes+commentaires)/followers) sur ces posts récupérés — une
//   estimation usuelle mais pas un chiffre officiel Meta.
// - email et âge restent hors de portée de toute API Meta : ils ne sont
//   jamais touchés par cet endpoint (voir api/profiles/[id].js pour leur
//   édition manuelle).
//
// Correctif 2026-09-15 (8e passage) : la logique Graph API elle-même a été
// déplacée dans lib/business-discovery.js pour être réutilisable par le
// nouveau bouton "Synchroniser tous les profils" (voir
// api/profiles/sync-all-business.js) sans dupliquer le code — ce fichier ne
// fait plus que router la requête HTTP vers cette fonction partagée et
// traduire ses erreurs en codes HTTP, le comportement pour ce bouton-ci est
// inchangé.
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { syncOneInfluenceAccount, SyncError } = require('../../../lib/business-discovery');

const ERROR_STATUS = {
  facebook_not_connected: 400,
  profile_not_found_for_tenant: 404,
  profile_not_found: 404,
  instagram_handle_missing: 400,
  decrypt_failed: 500,
  ig_business_account_id_missing: 500,
  meta_api_error: 502,
  business_discovery_empty: 502,
};

module.exports = withTenantHandler(async (req, res, tenant) => {
  const { id } = req.query || {};
  if (!id) {
    sendJson(res, 400, { error: 'id_required' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  try {
    const result = await syncOneInfluenceAccount(tenant.id, id);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof SyncError) {
      sendJson(res, ERROR_STATUS[err.code] || 500, { error: err.code, message: err.message, detail: err.detail });
      return;
    }
    sendJson(res, 500, { error: 'unexpected_error', detail: err.message });
  }
});
