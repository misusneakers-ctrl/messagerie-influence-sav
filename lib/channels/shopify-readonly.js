// Client Shopify Admin API en lecture seule, pour la frontière SAV <-> retours.
// Credentials distinctes des apps d'écriture misu-webhook/bbp-webhook — scope
// minimal read_orders (+ read_returns si exposé séparément par la boutique).
// AUCUNE fonction d'écriture ici, volontairement : pas de remboursement,
// pas d'annulation, pas de modification de commande.
//
// Authentification : token Admin API obtenu via le flux OAuth standard
// (authorization_code), posé une fois pour toutes en base — permanent tant que
// l'appli reste installée. Utilisé directement dans X-Shopify-Access-Token.
//
// Namespace et clés VÉRIFIÉS le 9 septembre 2026 en lisant lib/shopify.js et
// api/{create-return,receive-return}.js du repo GitHub misusneakers-ctrl/misu-webhook :
// - namespace réel côté Misü : "misu" (PAS "custom"), le slug du tenant.
// - return_status : "REQUESTED" | "RECEIVED" | "DISPUTED"
// - return_label : "<numéro d'étiquette> / <numéro de suivi>"
// - exchange_order : nom de la commande d'échange créée (vide si remboursement seul)
// - settlement : JSON { type, amount, currency, fee?, detail?, manual: true }
// - return_id : identifiant du retour
// - PAS de "return_received_date" ni de "return_type" (n'existent pas réellement)
//
// Côté BBP : CONFIRMÉ le 11 septembre 2026 en lisant lib/dropbox.js et
// api/{create-return,receive-return,track-order}.js du repo GitHub
// misusneakers-ctrl/bbp-webhook — l'hypothèse "même motif, namespace bbp" ci-dessus
// était FAUSSE. BBP ne pose aucun métachamp de retour sur Shopify : les retours
// vivent uniquement dans Dropbox (RETURNS.csv pour le détail par article,
// INVENTORY.csv pour le statut par étiquette/retour). Empiriquement vérifié sur
// la commande C294671 (retour R-C294671-1) : les métachamps ci-dessous renvoient
// tous `null` pour BBP alors qu'un retour existe bel et bien.
// Pour BBP, ce module appelle donc un endpoint de lecture seule dédié exposé par
// bbp-webhook (GET /api/return-status) plutôt que d'interroger des métachamps
// inexistants — conformément à la spec ("le noyau messagerie lit ces métachamps
// en lecture seule ; il ne duplique jamais la logique métier des retours") :
// bbp-webhook a déjà la logique CSV/Dropbox, on ne la duplique pas ici.
function metafieldNamespaceForTenant(tenantSlug) {
  return tenantSlug;
}

const GRAPHQL_ENDPOINT_VERSION = '2025-10';

// bbp-webhook expose /api/return-status derrière un secret partagé (en-tête
// X-Sav-Secret) — appel serveur à serveur uniquement, jamais depuis un
// navigateur. Même secret posé en variable d'environnement des deux côtés
// (BBP_SAV_READONLY_SECRET), aucune valeur en dur dans ce fichier.
const BBP_WEBHOOK_BASE_URL = process.env.BBP_WEBHOOK_BASE_URL || 'https://bbp-webhook.vercel.app';
const BBP_SAV_SECRET = process.env.BBP_SAV_READONLY_SECRET;

function buildOrderQuery(namespace) {
  return `
    query OrderContext($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            name
            email
            displayFinancialStatus
            displayFulfillmentStatus
            note
            shippingAddress { address1 city zip country }
            fulfillments(first: 5) {
              trackingInfo { number company url }
            }
            returnStatus: metafield(namespace: "${namespace}", key: "return_status") { value }
            returnLabel: metafield(namespace: "${namespace}", key: "return_label") { value }
            exchangeOrder: metafield(namespace: "${namespace}", key: "exchange_order") { value }
            returnIdField: metafield(namespace: "${namespace}", key: "return_id") { value }
            settlement: metafield(namespace: "${namespace}", key: "settlement") { value }
          }
        }
      }
    }
  `;
}

function parseSettlement(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Lecture seule des retours BBP via bbp-webhook (lui-même lecteur de Dropbox).
// Ne lève jamais : une erreur ici ne doit pas faire échouer le reste du
// contexte commande (adresse, tracking...), qui reste utile même sans retour.
async function getBbpReturnStatus(orderNumber) {
  if (!BBP_SAV_SECRET) {
    console.error('BBP_SAV_READONLY_SECRET manquant — lecture retours BBP ignorée.');
    return null;
  }
  const url = `${BBP_WEBHOOK_BASE_URL}/api/return-status?order=${encodeURIComponent(orderNumber)}`;
  const response = await fetch(url, {
    headers: { 'X-Sav-Secret': BBP_SAV_SECRET },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`bbp-webhook return-status failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload.returns || [];
}

async function getOrderContext({ shopDomain, accessToken, orderNumber, tenantSlug }) {
  const namespace = metafieldNamespaceForTenant(tenantSlug);

  const url = `https://${shopDomain}/admin/api/${GRAPHQL_ENDPOINT_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: buildOrderQuery(namespace),
      variables: { query: `name:${orderNumber}` },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors) {
    const err = new Error(payload.errors ? JSON.stringify(payload.errors) : 'shopify_read_failed');
    err.code = 'shopify_read_failed';
    throw err;
  }
  const edge = payload.data?.orders?.edges?.[0];
  if (!edge) return null;
  const order = edge.node;

  const base = {
    order_number: order.name,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    customer_email: order.email,
    shipping_address: order.shippingAddress,
    tracking: (order.fulfillments || []).flatMap((f) => f.trackingInfo || []),
    notes: order.note || null,
  };

  if (tenantSlug === 'bbp') {
    let bbpReturns = null;
    try {
      bbpReturns = await getBbpReturnStatus(order.name);
    } catch (err) {
      console.error('Erreur lecture retours BBP (bbp-webhook)', err.message);
    }
    // Retour le plus récent en tête d'affichage (multi-retours possibles par
    // commande côté BBP) ; le détail complet reste dans `returns`.
    const latest = bbpReturns && bbpReturns.length ? bbpReturns[bbpReturns.length - 1] : null;
    return {
      ...base,
      return_status: latest?.return_status || null,
      return_label: latest?.tracking_number || null,
      exchange_order: latest?.draft_order_id || null,
      return_id: latest?.return_id || null,
      settlement: null,
      returns: bbpReturns || [],
    };
  }

  return {
    ...base,
    return_status: order.returnStatus?.value || null,
    return_label: order.returnLabel?.value || null,
    exchange_order: order.exchangeOrder?.value || null,
    return_id: order.returnIdField?.value || null,
    settlement: parseSettlement(order.settlement?.value),
  };
}

module.exports = { getOrderContext };
