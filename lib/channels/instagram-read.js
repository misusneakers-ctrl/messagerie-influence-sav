// lib/channels/instagram-read.js
// Lecture seule des conversations Instagram (Conversations API) — phase B du
// connecteur direct (voir PLAN-ARCHITECTURE-Messagerie-Influence-SAV.md,
// section 3, et TRANSMISSION-Messagerie-Influence-SAV.md).
//
// N'écrit jamais sur Instagram et ne crée jamais de brouillon automatiquement
// — se contente de faire remonter les messages entrants (et l'historique
// sortant déjà envoyé ailleurs, ex. Meta Business Suite) comme tickets et
// messages dans le noyau. Fichier volontairement séparé de
// lib/channels/instagram.js (qui gère isWithinResponseWindow et
// sendDirectMessage, déjà en production) pour ne jamais risquer de casser
// l'envoi en modifiant ce fichier-là.

const GRAPH_VERSION = 'v21.0';

async function graphGet(path, accessToken, params = {}) {
  const url = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null) url.searchParams.set(key, value);
  });
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url.toString());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload.error && payload.error.message) || `HTTP ${response.status}`;
    const err = new Error(message);
    err.graphError = payload.error || null;
    throw err;
  }
  return payload;
}

async function graphGetUrl(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload.error && payload.error.message) || `HTTP ${response.status}`;
    const err = new Error(message);
    err.graphError = payload.error || null;
    throw err;
  }
  return payload;
}

// Profil du compte pro connecté (id + username), via /me. Utilisé pour
// identifier de façon fiable le compte de la marque parmi les participants
// d'une conversation — voir getBusinessUsername plus bas et le commentaire
// dans sync-instagram.js : l'id renvoyé ici (ig_business_account_id, schéma
// "IG Login") ne correspond PAS à l'id que l'API Conversations utilise pour
// désigner ce même compte dans participants[].id (schéma différent, plus
// proche d'un id "page-scoped"). Le username, lui, est stable entre les deux
// API et sert donc de clé de comparaison fiable.
async function getBusinessProfile({ accessToken }) {
  return graphGet('me', accessToken, { fields: 'id,username' });
}

// Liste TOUTES les conversations du compte pro connecté, en parcourant les
// pages successives (payload.paging.next), triées par dernière interaction.
//
// Correctif 2026-09-15 : jusqu'ici une seule page (25 conversations,
// supposées triées par activité récente) était lue — hypothèse fausse dans
// ce cas précis : l'API Conversations ne garantit pas cet ordre, une
// conversation neuve peut très bien ne PAS apparaître dans les 25 premières
// renvoyées. Résultat observé le 15/09/2026 : un message de test resté
// invisible dans l'appli alors qu'il existait bien côté Instagram (32
// conversations au total pour BBP à ce moment-là, largement sous la limite
// de sécurité ci-dessous). On parcourt donc maintenant toutes les pages,
// avec un plafond de sécurité (maxPages) pour ne jamais boucler
// indéfiniment si le compte venait à avoir un très grand nombre de
// conversations actives.
async function listConversations({ accessToken, igBusinessAccountId, limit = 25, maxPages = 20 }) {
  let all = [];
  // updated_time demandé en plus d'id/participants : correctif 2026-09-15
  // (suite) — Luc a raison de vouloir traiter les conversations dans
  // l'ordre de la DERNIÈRE interaction (envoyée ou reçue), pas dans un
  // ordre arbitraire côté Meta. On demande donc ce champ et on trie
  // nous-mêmes ci-dessous, plutôt que de faire confiance à l'ordre déjà
  // renvoyé par l'API (qui s'est révélé peu fiable, voir plus haut).
  let payload = await graphGet(`${igBusinessAccountId}/conversations`, accessToken, {
    platform: 'instagram',
    fields: 'id,participants,updated_time',
    limit,
  });
  all = all.concat(payload.data || []);

  let pages = 1;
  let nextUrl = payload.paging && payload.paging.next;
  while (nextUrl && pages < maxPages) {
    payload = await graphGetUrl(nextUrl);
    all = all.concat(payload.data || []);
    nextUrl = payload.paging && payload.paging.next;
    pages += 1;
  }

  // Tri décroissant par updated_time (conversation la plus récemment
  // active en premier) : le message le plus récent — qu'il soit sortant ou
  // entrant — détermine l'ordre de traitement dans sync-instagram.js.
  all.sort((a, b) => {
    const ta = a.updated_time ? new Date(a.updated_time).getTime() : 0;
    const tb = b.updated_time ? new Date(b.updated_time).getTime() : 0;
    return tb - ta;
  });

  return all;
}

// Correctif 2026-09-14 : normalise le bloc `attachments` renvoyé par l'API
// Conversations (une image arrive sous item.image_data.url, une vidéo sous
// item.video_data.url, un fichier générique sous item.file_url — jamais les
// trois en même temps sur un même item) vers une forme unique et stable
// utilisée partout ailleurs dans l'appli (front compris) :
// [{ type: 'image'|'video'|'file', url }]. Un item dont on ne reconnaît
// aucune de ces trois clés est ignoré plutôt que de planter l'import.
function normalizeAttachments(rawAttachments) {
  const items = (rawAttachments && rawAttachments.data) || [];
  return items
    .map((item) => {
      if (item.image_data && item.image_data.url) return { type: 'image', url: item.image_data.url };
      if (item.video_data && item.video_data.url) return { type: 'video', url: item.video_data.url };
      if (item.file_url) return { type: 'file', url: item.file_url };
      return null;
    })
    .filter(Boolean);
}

// Récupère les derniers messages d'une conversation donnée, triés du plus
// ancien au plus récent (l'API renvoie généralement l'ordre inverse).
//
// Correctif 2026-09-14 : le champ `attachments` n'était jusqu'ici jamais
// demandé à l'API (seuls id,created_time,from,to,message l'étaient) — un
// message Instagram composé uniquement d'une image ou d'une vidéo remontait
// donc avec un texte vide et AUCUNE pièce jointe, silencieusement, aussi
// bien pour les nouveaux messages que pour les anciens réimportés. Chaque
// message renvoyé porte maintenant un champ `attachments` déjà normalisé
// (voir normalizeAttachments ci-dessus), prêt à être stocké tel quel.
async function getConversationMessages({ accessToken, conversationId, limit = 30 }) {
  const data = await graphGet(conversationId, accessToken, {
    fields: `messages.limit(${limit}){id,created_time,from,to,message,attachments{image_data,video_data,file_url}}`,
  });
  const messages = (data.messages && data.messages.data) || [];
  return messages
    .slice()
    .reverse()
    .map((m) => ({ ...m, attachments: normalizeAttachments(m.attachments) }));
}

module.exports = { listConversations, getConversationMessages, getBusinessProfile };
