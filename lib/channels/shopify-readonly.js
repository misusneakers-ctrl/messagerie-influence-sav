// Client Shopify Admin API en lecture seule, pour la frontière SAV <-> retours.
// Credentials distinctes des apps d'écriture misu-webhook/bbp-webhook — scope
// minimal read_orders (+ read_returns si exposé séparément par la boutique).
// AUCUNE fonction d'écriture ici, volontairement : pas de remboursement,
// pas d'annulation, pas de modification de commande.
//
// Utilise GraphQL (pas REST) pour lire aussi les métachamps de retour posés
// par les portails misu-webhook/bbp-webhook (return_status, return_received_date, ...)
// qui sont des métachamps de commande, pas des note_attributes.

// À VÉRIFIER avant usage : le namespace/clé exacts des métachamps de retour
// posés par misu-webhook/bbp-webhook (lib/shopify.js de ces projets) n'ont
// pas été relus ici — "custom" est une hypothèse à confirmer, pas un fait vérifié.
const GRAPHQL_ENDPOINT_VERSION = '2025-01';

const ORDER_QUERY = `
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
          returnStatus: metafield(namespace: "custom", key: "return_status") { value }
          returnReceivedDate: metafield(namespace: "custom", key: "return_received_date") { value }
          returnType: metafield(namespace: "custom", key: "return_type") { value }
        }
      }
    }
  }
`;

async function getOrderContext({ shopDomain, accessToken, orderNumber }) {
  const url = `https://${shopDomain}/admin/api/${GRAPHQL_ENDPOINT_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: ORDER_QUERY,
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
    return_received_date: order.returnReceivedDate?.value || null,
    return_type: order.returnType?.value || null,
    notes: order.note || null,
  };
}

module.exports = { getOrderContext };
