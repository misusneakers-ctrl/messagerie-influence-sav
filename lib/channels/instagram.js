// Connecteur Instagram direct (Instagram API with Instagram Login).
// À VÉRIFIER avant mise en production : l'endpoint exact et la forme du
// payload évoluent parfois côté Meta — reconfirmer sur
// https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
// avant le premier envoi réel. Ce module ne fait AUCUNE hypothèse de succès :
// il ne renvoie "sent" que si Meta répond effectivement avec un id de message.

const GRAPH_BASE = process.env.INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com';
const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v21.0';

/**
 * Envoie UN message (texte OU pièce jointe, jamais les deux dans le même
 * appel — l'API Send de Meta n'accepte qu'une seule forme de "message" par
 * requête) à un destinataire Instagram ayant déjà initié une conversation
 * (recipientIgScopedId = l'IGSID renvoyé par le webhook entrant).
 * accessToken et igBusinessAccountId viennent des credentials déchiffrés du tenant.
 *
 * Correctif 2026-09-15 (pièce jointe sortante) : ajout du paramètre
 * `attachment` optionnel ({type: 'image'|'video'|'file', url}) — envoie la
 * pièce jointe par URL (déjà hébergée sur Vercel Blob storage par
 * api/uploads/attachment.js), avec `is_reusable: true` pour permettre à Meta
 * de réutiliser le média sans le re-télécharger sur un envoi ultérieur.
 * Exactement un des deux (`text` ou `attachment`) doit être fourni.
 */
async function sendDirectMessage({ accessToken, igBusinessAccountId, recipientIgScopedId, text, attachment }) {
  if (!accessToken || !igBusinessAccountId) {
    const err = new Error('instagram_credentials_missing');
    err.code = 'credentials_missing';
    throw err;
  }
  if (!text && !attachment) {
    const err = new Error('text_or_attachment_required');
    err.code = 'text_or_attachment_required';
    throw err;
  }

  const message = attachment
    ? { attachment: { type: attachment.type, payload: { url: attachment.url, is_reusable: true } } }
    : { text };

  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${igBusinessAccountId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgScopedId },
      message,
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
