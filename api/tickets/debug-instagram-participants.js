// Endpoint de diagnostic TEMPORAIRE — lecture seule, aucune écriture DB, aucun envoi.
// Objectif : comparer l'id renvoyé par l'API Conversations Instagram pour chaque participant
// avec le ig_business_account_id stocké en base, pour diagnostiquer le bug de fusion des tickets.
// À SUPPRIMER du dépôt une fois le diagnostic terminé.

const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');
const instagramRead = require('../../lib/channels/instagram-read');

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  const cred = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    return rows[0] || null;
  });

  if (!cred) {
    return sendJson(res, 400, { error: 'instagram_not_configured_for_tenant' });
  }

  const accessToken = decrypt(cred.encrypted_value);
  const igBusinessAccountId = cred.metadata && cred.metadata.ig_business_account_id;

  let conversations = [];
  try {
    conversations = await instagramRead.listConversations({
      accessToken,
      igBusinessAccountId,
      limit: 5,
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'instagram_api_error', detail: String(err && err.message || err) });
  }

  const debugConversations = conversations.map((conversation) => {
    const participants = (conversation.participants && conversation.participants.data) || [];
    return {
      conversation_id: conversation.id,
      participants: participants.map((p) => ({
        id: p.id,
        id_matches_stored_business_id: p.id === igBusinessAccountId,
        username: p.username,
      })),
    };
  });

  return sendJson(res, 200, {
    ig_business_account_id_from_metadata: igBusinessAccountId,
    conversations_sample: debugConversations,
  });
});
