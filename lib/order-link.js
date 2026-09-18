// lib/order-link.js
// Ajout 2026-09-18, demandé par Luc : « Un numéro de commande a été donné par
// la cliente. Aucune association sur la commande n'a été faite directement.
// J'ai besoin que le contexte se fasse tout de suite. »
//
// Cas réel : @magalievaillant écrit le 17/09 « Bonjour commande C294632 passée
// il y a 6 jours, aucune nouvelle de l'expédition ». Le champ « Commande
// liée » du ticket restait vide, et il fallait ouvrir Shopify à la main.
//
// Ici, dès qu'un message entrant arrive (Instagram ou e-mail), on y cherche un
// numéro de commande, on le VÉRIFIE auprès de Shopify, et on le rattache au
// ticket s'il existe. Le ticket est donc déjà documenté quand Luc l'ouvre.
//
// Deux prudences :
// - on ne remplace jamais un numéro déjà saisi par Luc ;
// - on ne rattache rien sans confirmation Shopify. Un numéro inventé, mal
//   recopié ou appartenant à une autre boutique ne crée pas de faux lien.
//   C'est aussi ce qui permet d'accepter des formats différents selon la
//   marque sans les coder en dur : si Shopify ne connaît pas, on n'écrit pas.

const { getOrderContext } = require('./channels/shopify-readonly');
const { getReadonlyAccessToken } = require('./shopify/readonly-token');
const { logAudit } = require('./audit');

// Un numéro de commande porte un préfixe de lettres (C294632) ou un dièse
// (#1042). Un nombre nu est exclu : le numéro de suivi Mondial Relay du
// ticket Magalie, 92347676, ne doit surtout pas être pris pour une commande.
const MOTIF = /(?:^|[^\w])#?([A-Z]{1,3}\d{4,9})(?![\w])|(?:^|[^\w])#(\d{4,9})(?![\w])/gi;

/** Numéros de commande plausibles trouvés dans un texte, sans doublon. */
function findOrderCandidates(text) {
  const out = [];
  const source = String(text || '');
  let m;
  MOTIF.lastIndex = 0;
  while ((m = MOTIF.exec(source)) !== null) {
    const brut = m[1] || m[2];
    if (!brut) continue;
    const n = brut.toUpperCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Cherche un numéro de commande dans `text` et le rattache au ticket s'il
 * existe vraiment côté Shopify.
 *
 * Best-effort : jamais bloquant pour la synchronisation des messages, qui est
 * le travail principal. Une erreur réseau se traduit par « pas de lien », pas
 * par un message perdu.
 *
 * @returns {Promise<{order_number: string, source: string}|null>}
 */
async function autoLinkOrder(client, tenant, ticket, text, { actor = 'systeme' } = {}) {
  if (!ticket || ticket.related_order_number) return null;
  const candidats = findOrderCandidates(text);
  if (!candidats.length) return null;

  let accessToken = null;
  try {
    accessToken = await getReadonlyAccessToken(tenant);
  } catch {
    return null;
  }
  if (!accessToken) return null;

  for (const numero of candidats.slice(0, 3)) {
    let contexte = null;
    try {
      contexte = await getOrderContext({
        shopDomain: tenant.myshopify_domain,
        accessToken,
        orderNumber: numero,
        tenantSlug: tenant.slug,
      });
    } catch (err) {
      console.error('[commande] vérification impossible :', String(err.message || err).slice(0, 200));
      return null;
    }
    if (!contexte) continue; // numéro inconnu de cette boutique : on n'écrit rien

    // Course possible avec une saisie de Luc : on ne remplit que si c'est
    // toujours vide au moment de l'écriture.
    const { rows } = await client.query(
      `UPDATE tickets SET related_order_number = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND related_order_number IS NULL
        RETURNING id`,
      [ticket.id, tenant.id, numero]
    );
    if (!rows[0]) return null;

    try {
      await logAudit(client, tenant.id, {
        actor,
        action: 'order_auto_linked',
        entityType: 'ticket',
        entityId: ticket.id,
        details: { order_number: numero, source: 'message_du_contact' },
      });
    } catch {
      // Journal non bloquant.
    }
    return { order_number: numero, source: 'message_du_contact' };
  }
  return null;
}

module.exports = { autoLinkOrder, findOrderCandidates, MOTIF };
