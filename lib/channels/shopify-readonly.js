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
//   - namespace réel côté Misü : "misu" (PAS "custom"), le slug du tenant.
//   - return_status : "REQUESTED" | "RECEIVED" | "DISPUTED"
//   - return_label : "<numéro d'étiquette> / <numéro de suivi>"
//   - exchange_order : nom de la commande d'échange créée (vide si remboursement seul)
//   - settlement : JSON { type, amount, currency, fee?, detail?, manual: true }
//   - return_id : identifiant du retour
//   - PAS de "return_received_date" ni de "return_type" (n'existent pas réellement)
//
// Côté BBP : portail bbp-webhook en cours de déploiement, supposé même motif
// (namespace = "bbp") — à reconfirmer sur le code réel une fois déployé.
function metafieldNamespaceForTenant(tenantSlug) {
  return tenantSlug;
}

const GRAPHQL_ENDPOINT_VERSION = '2025-10';

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

  return {
    order_number: order.name,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    customer_email: order.email,
    shipping_address: order.shippingAddress,
    tracking: (order.fulfillments || []).flatMap((f) => f.trackingInfo || []),
    return_status: order.returnStatus?.value || null,
    return_label: order.returnLabel?.value || null,
    exchange_order: order.exchangeOrder?.value || null,
    return_id: order.returnIdField?.value || null,
    settlement: parseSettlement(order.settlement?.value),
    notes: order.note || null,
  };
}

module.exports = { getOrderContext };
