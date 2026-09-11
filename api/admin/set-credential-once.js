// ⚠️ ENDPOINT TEMPORAIRE — à SUPPRIMER du dépôt GitHub juste après usage.
const { withoutTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');

const SETUP_SECRET = '7bc368f76452afefeeb24050360e78ceb49e3bc92a2bb3cb';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-setup-secret'] !== SETUP_SECRET) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const { tenant, type, value, meta } = req.body || {};
  if (!tenant || !type || !value) {
    res.status(400).json({ error: 'tenant_type_value_required' });
    return;
  }

  try {
    const encrypted = encrypt(value);
    await withoutTenant(async (client) => {
      const { rows } = await client.query('SELECT id FROM tenants WHERE slug = $1', [tenant]);
      if (!rows[0]) {
        throw new Error(`Tenant inconnu : ${tenant}`);
      }
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = $3, metadata = $4, updated_at = now()`,
        [rows[0].id, type, encrypted, JSON.stringify(meta || {})]
      );
    });
    res.status(200).json({ ok: true, tenant, type });
  } catch (err) {
    console.error('set-credential-once error', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
};
