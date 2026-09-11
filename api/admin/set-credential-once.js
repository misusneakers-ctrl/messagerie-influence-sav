// ⚠️ ENDPOINT TEMPORAIRE — à SUPPRIMER du dépôt GitHub juste après usage.
// Raison d'être : DATABASE_URL et CREDENTIALS_ENCRYPTION_KEY sont verrouillées
// ("Secret") sur Vercel et absentes de tout fichier local, donc impossible de
// lancer scripts/set-tenant-credential.js depuis un poste local. Cet endpoint
// tourne côté Vercel, où ces deux variables SONT disponibles à l'exécution,
// et fait exactement ce que fait le script (mêmes fonctions lib/db.js et
// lib/crypto.js), juste déclenché par un appel HTTP protégé au lieu d'une
// commande locale.
//
// Usage (une seule fois, puis supprimer ce fichier du dépôt) :
//
//   curl -X POST https://messagerie-influence-sav.vercel.app/api/admin/set-credential-once \
//     -H "Content-Type: application/json" \
//     -H "X-Setup-Secret: 66530f85ad1f90c1f56492f4440c9d26268d44b82aea33bf" \
//     -d '{
//       "tenant": "bbp",
//       "type": "meta_instagram",
//       "value": "<COLLE_ICI_LE_TOKEN_IGAAf..._QUE_TU_AS_COPIE>",
//       "meta": {"ig_business_account_id": "17841404210763764"}
//     }'
//
// Ne JAMAIS coller le token lui-même dans le chat — seulement dans cette
// commande, exécutée dans ton propre Terminal.

const { withoutTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');

// Secret à usage unique généré pour cette seule opération. Sans rapport avec
// un quelconque secret existant du projet — inutile une fois ce fichier supprimé.
const SETUP_SECRET = '66530f85ad1f90c1f56492f4440c9d26268d44b82aea33bf';

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
    // Ne jamais renvoyer la valeur elle-même dans la réponse.
    res.status(200).json({ ok: true, tenant, type });
  } catch (err) {
    console.error('set-credential-once error', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
};
