// GET /api/ai/settings   réglages IA de la marque résolue + état (clé posée ?
//                          tickets jamais analysés, brouillons IA en attente...)
// PUT /api/ai/settings   met à jour les réglages (prénom de signature, ton,
//                          règles gifting, critères profils, interdits...)
// Ajout 2026-09-16 (brouillons IA). Les réglages sont propres à chaque
// marque (tenant_ai_settings.tenant_id) et relus à chaque analyse : un
// changement s'applique dès le brouillon suivant, sans redéploiement.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { loadAiSettings, countCandidates } = require('../../lib/ai/assistant');
const { isConfigured, getModel } = require('../../lib/ai/anthropic');

const TEXT_FIELDS = ['signature_name', 'brand_name', 'brand_voice', 'gifting_rules', 'profile_criteria', 'forbidden_topics', 'extra_instructions',
  // Commande gifting (ajout 2026-09-16)
  'gifting_discount_title', 'gifting_shipping_title_fr', 'gifting_shipping_title_intl'];
const NOT_NULL_TEXT = ['signature_name', 'gifting_discount_title', 'gifting_shipping_title_fr', 'gifting_shipping_title_intl'];
const BOOL_FIELDS = ['enabled', 'auto_draft'];
const MAX_TEXT = 4000;

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const data = await withTenant(tenant.id, async (client) => {
      const settings = await loadAiSettings(client, tenant);
      const { rows } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM ticket_messages
             WHERE tenant_id = $1 AND direction = 'outbound' AND status = 'draft' AND ai_generated = true) AS ai_drafts_pending,
           (SELECT count(*)::int FROM tickets
             WHERE tenant_id = $1 AND archived_at IS NULL AND gifting_decision IS NULL
               AND (ai_analysis->>'needs_decision') = 'true') AS decisions_required,
           (SELECT count(*)::int FROM tickets WHERE tenant_id = $1 AND ai_analyzed_at IS NOT NULL) AS analyzed`,
        [tenant.id]
      );
      const { rows: credRows } = await client.query(
        `SELECT metadata, updated_at FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_gifting'`,
        [tenant.id]
      );
      const giftingCred = credRows[0]
        ? { connected: true, shop: credRows[0].metadata?.shop || null, shop_name: credRows[0].metadata?.shop_name || null,
            scope: credRows[0].metadata?.scope || null, connected_at: credRows[0].metadata?.connected_at || credRows[0].updated_at }
        : { connected: false };
      // Ajout 2026-09-17 (enquête d'Alice) : état de la boîte e-mail SAV et de
      // l'accès Shopify en lecture (recherche de commandes).
      const { rows: otherCreds } = await client.query(
        `SELECT type, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type IN ('gmail_readonly', 'shopify_readonly')`,
        [tenant.id]
      );
      const gmailRow = otherCreds.find((c) => c.type === 'gmail_readonly');
      const gmail = gmailRow
        ? { connected: true, email: gmailRow.metadata?.email || null, connected_at: gmailRow.metadata?.connected_at || null }
        : { connected: false, app_configured: !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) };
      const shopifyReadonly = otherCreds.some((c) => c.type === 'shopify_readonly');
      return { settings, stats: rows[0], gifting: giftingCred, gmail, shopify_readonly: shopifyReadonly };
    });
    const neverAnalyzed = await countCandidates(tenant, 'classify');
    sendJson(res, 200, {
      settings: data.settings,
      stats: { ...data.stats, never_analyzed: neverAnalyzed },
      gifting: data.gifting,
      gmail: data.gmail,
      shopify_readonly: data.shopify_readonly,
      ai_configured: isConfigured(),
      model: getModel(),
    });
    return;
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const values = {};
    for (const f of TEXT_FIELDS) {
      if (body[f] !== undefined) {
        const v = body[f] == null ? null : String(body[f]).trim().slice(0, MAX_TEXT);
        values[f] = v === '' ? null : v;
      }
    }
    for (const f of BOOL_FIELDS) {
      if (body[f] !== undefined) values[f] = !!body[f];
    }
    for (const f of NOT_NULL_TEXT) {
      if (values[f] === null) {
        sendJson(res, 400, { error: `${f}_required` });
        return;
      }
    }
    if (body.gifting_quota_per_colorway !== undefined) {
      const n = parseInt(body.gifting_quota_per_colorway, 10);
      if (isNaN(n) || n < 0 || n > 1000) {
        sendJson(res, 400, { error: 'invalid_gifting_quota' });
        return;
      }
      values.gifting_quota_per_colorway = n;
    }
    const fields = Object.keys(values);
    if (fields.length === 0) {
      sendJson(res, 400, { error: 'nothing_to_update' });
      return;
    }

    const settings = await withTenant(tenant.id, async (client) => {
      // Ligne créée si absente (valeurs par défaut de la table), puis mise à jour.
      await client.query(
        `INSERT INTO tenant_ai_settings (tenant_id, signature_name)
         VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant.id, tenant.slug === 'misu' ? 'Louise' : 'Alice']
      );
      const sets = fields.map((f, i) => `${f} = $${i + 1}`);
      const params = fields.map((f) => values[f]);
      params.push(body.updated_by ? String(body.updated_by).slice(0, 80) : null, tenant.id);
      await client.query(
        `UPDATE tenant_ai_settings SET ${sets.join(', ')}, updated_by = $${fields.length + 1}, updated_at = now()
         WHERE tenant_id = $${fields.length + 2}`,
        params
      );
      await logAudit(client, tenant.id, {
        actor: body.updated_by || 'inconnu',
        action: 'ai_settings_updated',
        entityType: 'tenant_ai_settings',
        entityId: null,
        details: { fields },
      });
      return loadAiSettings(client, tenant);
    });
    sendJson(res, 200, { settings });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
