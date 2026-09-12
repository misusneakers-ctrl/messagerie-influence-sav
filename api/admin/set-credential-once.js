// Endpoint TEMPORAIRE — usage unique. À supprimer du dépôt immédiatement
// après avoir posé la credential Instagram de BBP (même mécanisme que celui
// utilisé le 9 et le 11 septembre 2026 pour les credentials Shopify
// shopify_readonly de Misü et BBP — voir PLAN-ARCHITECTURE-Messagerie-Influence-SAV.md).
//
// POST /api/admin/set-credential-once
// Body JSON : { "secret": "...", "tenant_slug": "bbp", "type": "instagram_business",
//               "value": "<token brut>", "metadata": { "ig_business_id": "...", "ig_username": "..." } }
//
// Le token n'est JAMAIS journalisé, jamais renvoyé dans la réponse, jamais
// stocké en clair : chiffré via lib/crypto.js (AES-256-GCM,
// CREDENTIALS_ENCRYPTION_KEY) avant d'être écrit dans tenant_credentials.
//
// ⚠️ SUPPRIMER CE FICHIER DU DÉPÔT DÈS QUE LA CREDENTIAL EST POSÉE.
// Le secret ci-dessous est à usage unique et n'a aucune valeur une fois le
// fichier supprimé.
const ONE_TIME_SECRET = 'kusjQxOmc7W6B3df01KfA2zssHA7M_AnippUUnrqINw';

const { withoutTenant } = require('../../lib/db');
const { resolveTenantBySlug } = require('../../lib/tenant');
const { encrypt } = require('../../lib/crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = req.body || {};
  if (body.secret !== ONE_TIME_SECRET) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const { tenant_slug, type, value, metadata } = body;
  if (!tenant_slug || !type || !value) {
    res.status(400).json({ error: 'tenant_slug, type et value sont requis' });
    return;
  }

  try {
    const tenant = await resolveTenantBySlug(String(tenant_slug));
    if (!tenant) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }

    const encryptedValue = encrypt(String(value));

    await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, type)
         DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                        metadata = EXCLUDED.metadata,
                        updated_at = now()`,
        [tenant.id, String(type), encryptedValue, metadata || {}]
      );
    });

    // Ne jamais renvoyer le token, même chiffré.
    res.status(200).json({ ok: true, tenant: tenant.slug, type: String(type) });
  } catch (err) {
    console.error('set-credential-once error', err);
    res.status(500).json({ error: 'internal_error' });
  }
};
