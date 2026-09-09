// Connecteur Instagram direct (Instagram API with Instagram Login).
// À VÉRIFIER avant mise en production : l'endpoint exact et la forme du
// payload évoluent parfois côté Meta — reconfirmer sur
// https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
// avant le premier envoi réel. Ce module ne fait AUCUNE hypothèse de succès :
// il ne renvoie "sent" que si Meta répond effectivement avec un id de message.

const GRAPH_BASE = process.env.INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com';
const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v21.0';

/**
 * Envoie un message texte à un destinataire Instagram ayant déjà initié une
 * conversation (recipientIgScopedId = l'IGSID renvoyé par le webhook entrant).
 * accessToken et igBusinessAccountId viennent des credentials déchiffrés du tenant.
 */
async function sendDirectMessage({ accessToken, igBusinessAccountId, recipientIgScopedId, text }) {
  if (!accessToken || !igBusinessAccountId) {
    const err = new Error('instagram_credentials_missing');
    err.code = 'credentials_missing';
    throw err;
  }
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${igBusinessAccountId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgScopedId },
      message: { text },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.message_id) {
    const err = new Error(payload.error?.message || 'instagram_send_failed');
    err.code = 'send_failed';
    err.details = payload;
    throw err;
  }

  return { externalMessageId: payload.message_id };
}

/**
 * Fenêtre de réponse Meta : 24h depuis le dernier message entrant du fil.
 * lastInboundAt est un Date (ou string ISO) — le message le plus récent
 * de direction 'inbound' sur le ticket.
 */
function isWithinResponseWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  const diffHours = (now.getTime() - last) / (1000 * 60 * 60);
  return diffHours <= 24;
}

module.exports = { sendDirectMessage, isWithinResponseWindow };
