// TEMPORAIRE — créé le 9 septembre 2026 pour poser le vrai token Admin API
// Shopify (obtenu via le flux OAuth authorization_code) sans avoir besoin de
// connaître DATABASE_URL / CREDENTIALS_ENCRYPTION_KEY en dehors de Vercel
// (ces deux variables sont marquées "Secret" et donc illisibles depuis le
// dashboard Vercel ou en local). Ce endpoint tourne côté Vercel, où ces
// variables sont déjà disponibles dans l'environnement d'exécution.
//
// À SUPPRIMER juste après utilisation (fichier + redéploiement) : c'est un
// endpoint d'écriture en base protégé par un simple secret partagé, pas fait
// pour rester en production.
const { withoutTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');

const ONE_TIME_SECRET = '77322b890cce1537ed888b25cc0c3d32';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-setup-secret'] !== ONE_TIME_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const { tenant, type, value } = req.body || {};
    if (!tenant || !type || !value) {
      res.status(400).json({ error: 'missing_fields' });
      return;
    }
    const encrypted = encrypt(value);
    await withoutTenant(async (client) => {
      const { rows } = await client.query('SELECT id FROM tenants WHERE slug = $1', [tenant]);
      if (!rows[0]) throw new Error('unknown_tenant');
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1,$2,$3,'{}')
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = $3, updated_at = now()`,
        [rows[0].id, type, encrypted]
      );
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur set-credential-once', err);
    res.status(500).json({ error: 'failed', message: err.message });
  }
};
