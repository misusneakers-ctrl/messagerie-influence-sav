// Endpoint TEMPORAIRE — usage unique. À SUPPRIMER DU DÉPÔT IMMÉDIATEMENT
// après avoir posé la credential Instagram. Voir
// TRANSMISSION-Messagerie-Influence-SAV.md pour l'historique de ce mécanisme.
//
// POST /api/admin/set-ig-credential-once-2
// Body JSON : { "secret": "...", "tenant_slug": "bbp",
//               "type": "meta_instagram", "value": "<token brut, SANS chevrons>",
//               "metadata": { "ig_business_account_id": "17841404210763764" } }
const ONE_TIME_SECRET = 'kGNx1sd4b_HKIWJYc4bdtG-4fWXOR6rtvzLXuO_b3zQ';

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

    res.status(200).json({ ok: true, tenant: tenant.slug, type: String(type) });
  } catch (err) {
    console.error('set-ig-credential-once-2 error', err);
    res.status(500).json({ error: 'internal_error' });
  }
};
