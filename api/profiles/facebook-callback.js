// GET /api/profiles/facebook-callback?code=...&state=<slug tenant>
// Réception du retour du flux "Facebook Login for Business" démarré par
// facebook-login.js. Échange le code contre un token, retrouve la Page
// Facebook (et le compte Instagram pro qui lui est lié), et stocke un
// nouveau credential tenant_credentials de type 'meta_business_discovery' —
// distinct de 'meta_instagram' (celui-ci sert la lecture/l'envoi de DM via
// Instagram Login, ne pas confondre ni écraser). Correctif 2026-09-15.
//
// Ce que ce credential permettra ensuite (endpoint de sync à venir,
// api/profiles/[id]/sync-business.js) : interroger l'API Business Discovery
// de Meta (photo de profil, followers, engagement, tags à partir des
// derniers posts publics) sur le compte Instagram d'UN INFLUENCEUR TIERS —
// ça n'a rien à voir avec le compte Instagram de la marque elle-même.
const { resolveTenantBySlug } = require('../../lib/tenant');
const { withTenant } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');

const META_APP_ID = '1776379956832524';
const REDIRECT_URI = 'https://messagerie-influence-sav.vercel.app/api/profiles/facebook-callback';
const GRAPH_VERSION = 'v21.0';

// Correctif 2026-09-15 (3e passage) : Luc administre des Pages réparties sur
// PLUSIEURS Business Portfolios Meta distincts (BBP et Misü), et /me/accounts
// renvoie toutes les Pages éligibles pêle-mêle, dans un ordre non garanti —
// prendre pagesWithIg[0] revenait à associer au hasard la Page de l'une des
// marques au tenant en train de se connecter (bug constaté le 15/09 : le
// flux lancé pour "bbp" a stocké le compte Instagram de Misü). On verrouille
// donc explicitement, par tenant, le handle Instagram professionnel attendu
// (voir DIAGNOSTIC_BBDP_DM_INSTAGRAM_20260909.md) et on ne retient QUE la
// Page dont le compte Instagram lié correspond — sinon on affiche une erreur
// claire plutôt que de stocker silencieusement la mauvaise Page.
const EXPECTED_IG_USERNAME_BY_TENANT = {
  bbp: 'bonsbaisers.paris',
  misu: 'misu.sneakers',
};

function htmlPage(title, bodyHtml) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
h1{font-size:20px}.ok{color:#1a7f37}.err{color:#b3261e}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style>
</head><body>${bodyHtml}</body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { code, state, error, error_description: errorDescription } = req.query || {};

  if (error) {
    res.status(400).send(htmlPage('Connexion annulée',
      `<h1 class="err">Connexion Facebook annulée</h1><p>${errorDescription || error}</p>`));
    return;
  }
  if (!code || !state) {
    res.status(400).send(htmlPage('Erreur', '<h1 class="err">Paramètres manquants</h1><p>code ou state absent du retour Facebook.</p>'));
    return;
  }

  const tenant = await resolveTenantBySlug(String(state));
  if (!tenant) {
    res.status(404).send(htmlPage('Erreur', `<h1 class="err">Marque inconnue</h1><p>"${state}"</p>`));
    return;
  }

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    res.status(500).send(htmlPage('Erreur de configuration',
      '<h1 class="err">META_APP_SECRET manquant</h1><p>Variable d\'environnement absente sur Vercel — à ajouter (Project Settings → Environment Variables) avant de refaire cette connexion.</p>'));
    return;
  }

  try {
    // 1. Code -> token utilisateur (courte durée)
    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', META_APP_ID);
    tokenUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', String(code));
    const tokenResp = await fetch(tokenUrl.toString());
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      throw new Error(`Échange du code échoué : ${JSON.stringify(tokenJson)}`);
    }

    // 2. Token utilisateur courte durée -> longue durée (~60 jours, puis
    // les tokens de Page obtenus à partir de lui n'expirent pas tant que
    // Luc reste connecté et n'a pas révoqué l'accès).
    const longLivedUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longLivedUrl.searchParams.set('client_id', META_APP_ID);
    longLivedUrl.searchParams.set('client_secret', appSecret);
    longLivedUrl.searchParams.set('fb_exchange_token', tokenJson.access_token);
    const longLivedResp = await fetch(longLivedUrl.toString());
    const longLivedJson = await longLivedResp.json();
    if (!longLivedResp.ok || !longLivedJson.access_token) {
      throw new Error(`Passage en longue durée échoué : ${JSON.stringify(longLivedJson)}`);
    }
    const userToken = longLivedJson.access_token;

    // 3. Pages gérées par Luc + compte Instagram pro lié à chacune.
    const pagesUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`);
    pagesUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
    pagesUrl.searchParams.set('access_token', userToken);
    const pagesResp = await fetch(pagesUrl.toString());
    const pagesJson = await pagesResp.json();
    if (!pagesResp.ok || !Array.isArray(pagesJson.data)) {
      throw new Error(`Récupération des Pages échouée : ${JSON.stringify(pagesJson)}`);
    }

    const pagesWithIg = pagesJson.data.filter((p) => p.instagram_business_account);
    const expectedUsername = EXPECTED_IG_USERNAME_BY_TENANT[tenant.slug] || null;

    if (pagesWithIg.length === 0) {
      res.status(200).send(htmlPage('Aucun compte Instagram lié',
        `<h1 class="err">Aucune Page avec un compte Instagram professionnel lié</h1>
        <p>Facebook a renvoyé ${pagesJson.data.length} Page(s) (${pagesJson.data.map((p) => p.name).join(', ') || 'aucune'}),
        mais aucune n'a de compte Instagram professionnel associé.</p>
        <p>Vérifie dans Meta Business Suite que le compte Instagram (@${expectedUsername || tenant.slug})
        est bien relié à une Page Facebook, puis relance la connexion.</p>`));
      return;
    }

    // Verrouillage par tenant : on ne retient que la Page dont le compte
    // Instagram lié correspond exactement au handle attendu pour cette
    // marque, jamais un choix positionnel.
    const chosen = expectedUsername
      ? pagesWithIg.find(
          (p) =>
            p.instagram_business_account.username &&
            p.instagram_business_account.username.toLowerCase() === expectedUsername.toLowerCase()
        )
      : null;

    if (!chosen) {
      const foundList = pagesWithIg
        .map((p) => `@${p.instagram_business_account.username || p.instagram_business_account.id} (Page "${p.name}")`)
        .join(', ');
      res.status(200).send(htmlPage('Mauvais compte Instagram',
        `<h1 class="err">Le compte Instagram attendu pour ${tenant.name} n'a pas été trouvé</h1>
        <p>Facebook a proposé ${pagesWithIg.length} Page(s) avec compte Instagram lié : ${foundList || 'aucune'}.</p>
        <p>Aucune ne correspond au compte attendu pour cette marque${expectedUsername ? ` (<strong>@${expectedUsername}</strong>)` : ''}.</p>
        <p>Vérifie dans Meta Business Suite que le compte Instagram @${expectedUsername || tenant.slug} est bien relié
        à une Page Facebook dans le Business Portfolio de ${tenant.name}, et que tu as accepté cette Page lors de
        l'écran de sélection Facebook (⚠️ Facebook affiche parfois un écran "Sélectionner les Pages" où il faut
        cocher explicitement la bonne Page avant de continuer). Puis relance la connexion.</p>`));
      return;
    }

    await withTenant(tenant.id, async (client) => {
      const metadata = {
        page_id: chosen.id,
        page_name: chosen.name,
        ig_business_account_id: chosen.instagram_business_account.id,
        ig_username: chosen.instagram_business_account.username || null,
        connected_at: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO tenant_credentials (tenant_id, type, encrypted_value, metadata)
         VALUES ($1, 'meta_business_discovery', $2, $3)
         ON CONFLICT (tenant_id, type) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
        [tenant.id, encrypt(chosen.access_token), JSON.stringify(metadata)]
      );
      await logAudit(client, tenant.id, {
        actor: 'manual',
        action: 'facebook_business_login_connected',
        entityType: 'tenant_credentials',
        entityId: null,
        details: metadata,
      });
    });

    res.status(200).send(htmlPage('Connecté',
      `<h1 class="ok">✅ Connexion réussie pour ${tenant.name}</h1>
      <p>Page Facebook : <strong>${chosen.name}</strong><br>
      Compte Instagram lié : <strong>@${chosen.instagram_business_account.username || chosen.instagram_business_account.id}</strong></p>
      <p>Tu peux fermer cet onglet et retourner sur la messagerie.</p>`));
  } catch (err) {
    res.status(502).send(htmlPage('Erreur',
      `<h1 class="err">Erreur pendant la connexion</h1><p><code>${(err && err.message) || err}</code></p>`));
  }
};
