// GET  /api/webhooks/instagram   handshake de vérification Meta (hub.challenge)
// POST /api/webhooks/instagram   événements entrants (messages, comments, mentions)
//
// Particularité multi-tenant : contrairement aux autres endpoints, on ne
// connaît PAS le tenant avant d'avoir lu le corps de la requête (l'ID du
// compte Instagram business appelé est dans entry[].id). On utilise donc
// withoutTenant (voir lib/db.js) pour la résolution, puis on repasse en
// scope tenant (withTenant) pour créer/mettre à jour le ticket.
//
// Vérification de signature : Meta signe chaque appel POST avec
// X-Hub-Signature-256 (HMAC SHA256 du corps brut, avec le client_secret de
// l'app Instagram). Comme on ne connaît le tenant (et donc son secret)
// qu'après avoir lu entry[].id dans le corps, l'ordre est : lire le corps,
// résoudre le tenant par ig_business_account_id, récupérer son secret
// déchiffré, PUIS vérifier la signature avant de traiter quoi que ce soit.
//
// ⚠️ Point à vérifier au premier test réel (pas garanti à 100% sans déploiement) :
// selon la façon dont ce projet Vercel expose req.body (JSON déjà parsé ou
// non), le calcul HMAC peut nécessiter le corps brut exact plutôt que
// JSON.stringify(req.body) reconstruit — les deux ne sont PAS toujours
// identiques (ordre des clés, espaces). Si la vérification de signature
// échoue systématiquement en conditions réelles, c'est la première piste à
// creuser (voir commentaire sur getRawBody plus bas).

const crypto = require('crypto');
const { withTenant, withoutTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');

// Correctif sécurité 2026-09-14 : ce token était en dur dans le code, sur un
// repo public (même mauvaise pratique que les fuites de credentials déjà
// notées à trois reprises — voir TRANSMISSION-Messagerie-Influence-SAV.md).
// Il ne sert qu'à la poignée de main de souscription du webhook (moins
// critique qu'un secret d'app), mais sort quand même du code : à poser sur
// Vercel comme variable d'environnement WEBHOOK_VERIFY_TOKEN, avec la même
// valeur que celle déjà configurée côté Meta Dev Dashboard pour ce webhook
// ('0d2ae112e87fb8f3d5f77677d96152f8' au moment de ce correctif — à
// reporter telle quelle dans la variable d'env pour ne rien casser).
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

async function findTenantByInstagramAccountId(igAccountId) {
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.slug, tc.encrypted_value AS app_secret_encrypted
       FROM tenant_credentials tc
       JOIN tenants t ON t.id = tc.tenant_id
       WHERE tc.type = 'meta_app_secret'
         AND tc.metadata->>'ig_business_account_id' = $1
       LIMIT 1`,
      [igAccountId]
    );
    return rows[0] || null;
  });
}

function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false; // longueurs différentes, etc.
  }
}

// Reconstruit le corps brut à partir de req.body. À remplacer par la lecture
// du flux brut (req sur son event 'data') si la vérification de signature
// échoue en conditions réelles — voir avertissement en tête de fichier.
function getRawBodyApprox(req) {
  return JSON.stringify(req.body);
}

function classifyEntry(entry) {
  if (entry.messaging) return 'dm';
  if (entry.changes?.some((c) => c.field === 'comments')) return 'comment';
  if (entry.changes?.some((c) => c.field === 'mentions')) return 'mention';
  return 'autre';
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).json({ error: 'verify_token_mismatch' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const entries = req.body?.entry || [];
  const results = [];

  for (const entry of entries) {
    const igAccountId = entry.id;
    if (!igAccountId) {
      results.push({ entry_id: null, status: 'skipped_no_id' });
      continue;
    }

    const tenantRow = await findTenantByInstagramAccountId(igAccountId);
    if (!tenantRow) {
      results.push({ entry_id: igAccountId, status: 'tenant_not_found' });
      continue;
    }

    const appSecret = decrypt(tenantRow.app_secret_encrypted);
    const signatureHeader = req.headers['x-hub-signature-256'];
    const rawBody = getRawBodyApprox(req);
    if (!verifySignature(rawBody, signatureHeader, appSecret)) {
      results.push({ entry_id: igAccountId, status: 'signature_invalid' });
      continue;
    }

    const subtype = classifyEntry(entry);

    await withTenant(tenantRow.id, async (client) => {
      // Une seule voie d'entrée pour un ticket Instagram existant : le
      // thread externe (external_thread_id). À défaut d'ID de conversation
      // clair selon le sous-type, on retombe sur l'ID d'entrée Meta — point
      // à affiner une fois la vraie forme du payload observée en prod.
      const externalThreadId = entry.messaging?.[0]?.sender?.id
        || entry.changes?.[0]?.value?.id
        || `${igAccountId}:${subtype}`;

      // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté sur ces deux
      // requêtes. Le tenant est déjà résolu sans ambiguïté par
      // ig_business_account_id ci-dessus, donc le risque pratique était
      // faible (il aurait fallu une collision d'external_thread_id entre
      // deux comptes Instagram différents), mais rien ne doit dépendre de
      // RLS dans cette appli (rôle applicatif en BYPASSRLS — voir
      // TRANSMISSION-Messagerie-Influence-SAV.md).
      const { rows: existing } = await client.query(
        `SELECT id, merged_into_ticket_id FROM tickets WHERE tenant_id = $1 AND channel = 'instagram' AND external_thread_id = $2 LIMIT 1`,
        [tenantRow.id, externalThreadId]
      );

      let ticketId;
      if (existing[0]) {
        // Ajout 2026-09-17 : conversation fusionnée → ticket cible.
        ticketId = existing[0].merged_into_ticket_id || existing[0].id;
        await client.query(
          `UPDATE tickets SET status = 'a_traiter', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [ticketId, tenantRow.id]
        );
      } else {
        const category = subtype === 'comment' || subtype === 'mention' ? 'Influence' : 'Autre';
        const { rows: created } = await client.query(
          `INSERT INTO tickets
             (tenant_id, channel, category, status, external_thread_id, summary)
           VALUES ($1,'instagram',$2,'a_traiter',$3,$4)
           RETURNING id`,
          [tenantRow.id, category, externalThreadId, `Instagram ${subtype} reçu`]
        );
        ticketId = created[0].id;
      }

      await logAudit(client, tenantRow.id, {
        actor: 'webhook:instagram',
        action: 'inbound_event',
        entityType: 'ticket',
        entityId: ticketId,
        details: { subtype, ig_account_id: igAccountId },
      });

      results.push({ entry_id: igAccountId, status: 'ok', ticket_id: ticketId, subtype });
    });
  }

  // Toujours 200 : Meta désabonne un webhook qui échoue trop souvent.
  res.status(200).json({ results });
};
