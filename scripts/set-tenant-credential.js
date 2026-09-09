// Usage :
//   DATABASE_URL=... CREDENTIALS_ENCRYPTION_KEY=... node scripts/set-tenant-credential.js \
//     --tenant bbp --type meta_instagram --value "<access_token>" --meta '{"ig_business_account_id":"17841404210763764"}'
//
// Pose ou remplace une credential chiffrée pour un tenant. Ne jamais coller
// la valeur en clair ailleurs qu'ici (chat, dépôt, logs) — ce script ne
// l'affiche jamais après coup.
const { withoutTenant } = require('../lib/db');
const { encrypt } = require('../lib/crypto');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { tenant, type, value, meta } = parseArgs();
  if (!tenant || !type || !value) {
    console.error('Usage: --tenant <slug> --type <meta_instagram|shopify_readonly> --value <secret> [--meta \'{"...json..."}\']');
    process.exit(1);
  }
  const metadata = meta ? JSON.parse(meta) : {};
  const encrypted = encrypt(value);

  await withoutTenant(async (client) => {
    const { rows } = await client.query('SELECT id FROM tenants WHERE slug = $1', [tenant]);
    if (!rows[0]) throw new Error(`Tenant inconnu : ${tenant}`);
    await client.query(
      `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = $3, metadata = $4, updated_at = now()`,
      [rows[0].id, type, encrypted, JSON.stringify(metadata)]
    );
  });

  console.log(`Credential '${type}' posée pour le tenant '${tenant}'.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
