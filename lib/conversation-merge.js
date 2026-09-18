// lib/conversation-merge.js
// Ajout 2026-09-18, demandé par Luc : « tu as lié le compte Instagram avec un
// numéro de commande dès qu'il apparaît — il faut directement le lier aussi à
// l'adresse e-mail, pour retrouver les e-mails s'il y en a, et faire merger
// les discussions dans la timeline de discussion. »
//
// Enchaînement complet, déclenché à la synchronisation :
//   message entrant → numéro de commande repéré et vérifié (lib/order-link.js)
//   → e-mail de la cliente lu sur la commande Shopify → tickets e-mail de
//   cette adresse retrouvés → fusion dans une seule conversation.
//
// Luc a choisi la fusion AUTOMATIQUE plutôt qu'une proposition à valider. Les
// prudences qui vont avec :
// - on ne fusionne que sur une adresse e-mail issue de la COMMANDE, jamais sur
//   une ressemblance de nom ou de pseudo ;
// - jamais de fusion d'un ticket déjà fusionné ailleurs, ni d'un ticket
//   archivé, ni avec lui-même ;
// - au plus 3 fusions par passage, pour qu'une erreur d'association ne
//   propage pas ;
// - tout est réversible : la fusion déplace les messages et garde la liste
//   exacte dans ticket_merges, « Défaire » remet chaque chose à sa place.

const { getOrderContext } = require('./channels/shopify-readonly');
const { getReadonlyAccessToken } = require('./shopify/readonly-token');
const { mergeTickets } = require('./ticket-merge');

const MAX_FUSIONS = 3;

function normalizeEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

/**
 * E-mail de la cliente d'après la commande rattachée au ticket.
 * @returns {Promise<string|null>}
 */
async function emailFromOrder(tenant, orderNumber) {
  if (!orderNumber) return null;
  let accessToken = null;
  try {
    accessToken = await getReadonlyAccessToken(tenant);
  } catch {
    return null;
  }
  if (!accessToken) return null;
  try {
    const contexte = await getOrderContext({
      shopDomain: tenant.myshopify_domain,
      accessToken,
      orderNumber,
      tenantSlug: tenant.slug,
    });
    return normalizeEmail(contexte && contexte.customer_email);
  } catch (err) {
    console.error('[fusion] lecture commande impossible :', String(err.message || err).slice(0, 200));
    return null;
  }
}

/**
 * Complète l'e-mail du ticket depuis sa commande, puis fusionne dans ce
 * ticket les autres conversations de la même adresse.
 *
 * Best-effort : jamais bloquant pour la synchronisation.
 * @returns {Promise<{email: string, merged: Array}|null>}
 */
async function linkEmailAndMerge(client, tenant, ticket, { actor = 'systeme' } = {}) {
  if (!ticket) return null;
  let email = normalizeEmail(ticket.contact_email);

  if (!email && ticket.related_order_number) {
    email = await emailFromOrder(tenant, ticket.related_order_number);
    if (!email) return null;
    await client.query(
      `UPDATE tickets SET contact_email = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND contact_email IS NULL`,
      [ticket.id, tenant.id, email]
    );
  }
  if (!email) return null;

  // Autres conversations de la même adresse, encore vivantes.
  const { rows: candidats } = await client.query(
    `SELECT id, channel, created_at FROM tickets
      WHERE tenant_id = $1
        AND id <> $2
        AND lower(contact_email) = $3
        AND merged_into_ticket_id IS NULL
        AND archived_at IS NULL
      ORDER BY created_at ASC
      LIMIT $4`,
    [tenant.id, ticket.id, email, MAX_FUSIONS]
  );
  if (!candidats.length) return { email, merged: [] };

  const merged = [];
  for (const source of candidats) {
    try {
      const res = await mergeTickets(client, tenant, ticket.id, {
        source_ticket_id: source.id,
        merged_by: actor,
        evidence: {
          raison: 'même adresse e-mail que la commande rattachée',
          email,
          commande: ticket.related_order_number || null,
        },
      });
      merged.push({ source_ticket_id: source.id, channel: source.channel, merge_id: res.merge.id });
    } catch (err) {
      console.error('[fusion] impossible :', String(err.message || err).slice(0, 200));
    }
  }
  return { email, merged };
}

module.exports = { linkEmailAndMerge, emailFromOrder, normalizeEmail, MAX_FUSIONS };
