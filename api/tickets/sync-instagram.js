// POST /api/tickets/sync-instagram
// Sondage manuel des DM Instagram côté Meta (bouton "Actualiser Instagram"
// dans l'appli ; une tâche planifiée pourra appeler ce même endpoint plus
// tard sans rien changer côté front). Fait apparaître les nouveaux messages
// entrants comme tickets/messages dans le noyau. STRICTEMENT en lecture côté
// Instagram : ne répond jamais, ne crée jamais de brouillon, n'appelle aucune
// fonction d'envoi. Phase B du connecteur direct (lecture seule d'abord),
// voir PLAN-ARCHITECTURE-Messagerie-Influence-SAV.md section 3 et 5.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { autoLinkOrder } = require('../../lib/order-link');
const { linkEmailAndMerge } = require('../../lib/conversation-merge');
const { withTenant } = require('../../lib/db');
const { decrypt } = require('../../lib/crypto');
const { logAudit } = require('../../lib/audit');
const instagramRead = require('../../lib/channels/instagram-read');
const { findOrCreateInfluenceRelation } = require('../../lib/influence');

// Correctif 2026-09-15 : les messages de chaque conversation étaient
// récupérés un par un, en série (un aller-retour Instagram par
// conversation, attendu avant de passer au suivant) — avec la lecture de
// TOUTES les conversations (correctif précédent, plus seulement les 25
// premières), ça a fait grimper la durée totale du sondage à plusieurs
// minutes, au point de sembler "bloqué" dans l'appli. On lance maintenant
// ces appels par petits groupes en parallèle (CONCURRENCY à la fois) plutôt
// qu'un par un — même volume d'appels réseau, mais beaucoup moins de temps
// d'attente cumulé.
const CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const cred = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, metadata FROM tenant_credentials WHERE tenant_id = $1 AND type = 'meta_instagram'`,
      [tenant.id]
    );
    return rows[0] || null;
  });
  if (!cred) {
    sendJson(res, 400, { error: 'instagram_not_configured_for_tenant' });
    return;
  }

  let accessToken;
  try {
    accessToken = decrypt(cred.encrypted_value);
  } catch (err) {
    sendJson(res, 400, { error: 'decrypt_failed' });
    return;
  }

  const igBusinessAccountId = cred.metadata && cred.metadata.ig_business_account_id;
  if (!igBusinessAccountId) {
    sendJson(res, 400, { error: 'ig_business_account_id_missing' });
    return;
  }

  // L'id stocké (ig_business_account_id, obtenu via /me au moment de la
  // connexion, schéma "IG Login") ne correspond PAS à l'id que l'API
  // Conversations utilise pour désigner ce même compte dans
  // participants[].id (schéma différent — confirmé par diagnostic le
  // 12/09/2026, voir TRANSMISSION-Messagerie-Influence-SAV.md : cause du bug
  // de fusion de tous les contacts sous un seul ticket "bonsbaisers.paris").
  // On récupère donc le username du compte pro en direct, stable entre les
  // deux API, et on identifie le contact et le sens des messages par
  // comparaison de username plutôt que d'id.
  let businessUsername;
  try {
    const profile = await instagramRead.getBusinessProfile({ accessToken });
    businessUsername = profile && profile.username;
  } catch (err) {
    sendJson(res, 502, { error: 'instagram_api_error', detail: err.message });
    return;
  }
  if (!businessUsername) {
    sendJson(res, 502, { error: 'instagram_business_username_unavailable' });
    return;
  }

  let conversations;
  try {
    conversations = await instagramRead.listConversations({ accessToken, igBusinessAccountId });
  } catch (err) {
    sendJson(res, 502, { error: 'instagram_api_error', detail: err.message });
    return;
  }

  const summary = {
    conversations_scanned: conversations.length,
    tickets_created: 0,
    messages_created: 0,
    conversations_skipped: 0,
    remaining: 0,
    errors: [],
  };

  // Correctif 2026-09-18 (la synchro dépassait les 300 s de Vercel et
  // renvoyait 504 : « impossible d'actualiser »).
  //
  // Cause : on redemandait à Meta les messages des ~170 conversations, puis on
  // écrivait en base conversation par conversation, avec une requête par
  // message pour savoir s'il était déjà connu. Des milliers d'allers-retours.
  //
  // Première parade : on retient la date de dernière activité de chaque
  // conversation (`ig_conversation_updated_at`). Une conversation qui n'a pas
  // bougé depuis le dernier passage est ignorée — sans même appeler Meta.
  // Après le premier passage, une actualisation ne touche donc que ce qui a
  // réellement changé.
  const dejaVues = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT external_thread_id, ig_conversation_updated_at
         FROM tickets
        WHERE tenant_id = $1 AND channel = 'instagram' AND ig_conversation_updated_at IS NOT NULL`,
      [tenant.id]
    );
    const m = new Map();
    for (const r of rows) m.set(r.external_thread_id, new Date(r.ig_conversation_updated_at).getTime());
    return m;
  });

  function aBouge(conversation) {
    const maj = conversation.updated_time ? new Date(conversation.updated_time).getTime() : null;
    if (!maj) return true; // pas d'information : on regarde, par prudence
    const participants = (conversation.participants && conversation.participants.data) || [];
    const contact = participants.find((x) => x.username !== businessUsername);
    if (!contact) return true;
    const connu = dejaVues.get(contact.id);
    return !connu || maj > connu;
  }

  const aTraiter = conversations.filter(aBouge);
  summary.conversations_skipped = conversations.length - aTraiter.length;

  // Étape 1 : récupérer les messages de toutes les conversations en
  // parallèle (par lots de CONCURRENCY), au lieu d'un aller-retour Instagram
  // séquentiel par conversation — c'est cette étape qui dominait la durée
  // totale du sondage.
  const messagesByConversation = await mapWithConcurrency(
    aTraiter,
    CONCURRENCY,
    async (conversation) => {
      try {
        const messages = await instagramRead.getConversationMessages({
          accessToken,
          conversationId: conversation.id,
        });
        return { conversation, messages, error: null };
      } catch (err) {
        return { conversation, messages: null, error: err };
      }
    }
  );

  // Étape 2 : écrire en base, conversation par conversation, dans l'ordre
  // (le plus récent en premier — voir le tri par updated_time dans
  // lib/channels/instagram-read.js). Les écritures DB restent séquentielles
  // ici : chaque conversation ne fait qu'un aller-retour Postgres, largement
  // plus rapide qu'un aller-retour Instagram, donc paralléliser cette partie
  // n'aurait apporté qu'un gain marginal pour plus de complexité (risque de
  // conflits de transaction).
  // Deuxième parade : un budget de temps. Vercel coupe à 300 s ; on s'arrête
  // bien avant et on annonce ce qu'il reste, le front rappelle la route. Une
  // actualisation longue devient une suite d'actualisations courtes, au lieu
  // d'un 504 qui ne rend rien du tout.
  const BUDGET_MS = 45000;
  const debut = Date.now();
  let traitees = 0;

  for (const { conversation, messages, error } of messagesByConversation) {
    if (Date.now() - debut > BUDGET_MS) {
      summary.remaining = messagesByConversation.length - traitees;
      break;
    }
    traitees += 1;
    if (error) {
      summary.errors.push({ conversation_id: conversation.id, error: error.message });
      continue;
    }
    try {
      const participants = (conversation.participants && conversation.participants.data) || [];
      const contactParticipant = participants.find((p) => p.username !== businessUsername);
      const businessParticipant = participants.find((p) => p.username === businessUsername);
      if (!contactParticipant) continue; // pas d'interlocuteur identifiable, on ignore
      // Id du compte de la marque tel qu'utilisé DANS CETTE conversation
      // précise (schéma API Conversations, différent de igBusinessAccountId)
      // — sert à déterminer le sens (inbound/outbound) des messages plus bas.
      const businessParticipantId = businessParticipant ? businessParticipant.id : null;

      if (messages.length === 0) continue;

      await withTenant(tenant.id, async (client) => {
        // Un ticket par interlocuteur Instagram — external_thread_id = IGSID
        // du contact, le même identifiant que celui utilisé pour l'envoi
        // (voir lib/channels/instagram.js, sendDirectMessage).
        const { rows: existingTicketRows } = await client.query(
          `SELECT * FROM tickets WHERE tenant_id = $1 AND channel = 'instagram' AND external_thread_id = $2`,
          [tenant.id, contactParticipant.id]
        );
        let ticket = existingTicketRows[0];
        // Ajout 2026-09-17 (fusion de tickets) : si cette conversation a été
        // fusionnée dans une autre par Luc, les nouveaux messages vont dans le
        // ticket cible (voir api/tickets/[id]/merge.js).
        if (ticket && ticket.merged_into_ticket_id) {
          const { rows: targetRows } = await client.query(
            'SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2',
            [ticket.merged_into_ticket_id, tenant.id]
          );
          if (targetRows[0]) ticket = targetRows[0];
        }

        if (!ticket) {
          const [{ rows: defaultCategoryRows }, { rows: defaultStatusRows }] = await Promise.all([
            client.query(
              `SELECT label FROM ticket_field_options WHERE tenant_id = $1 AND field = 'category' AND is_default LIMIT 1`,
              [tenant.id]
            ),
            client.query(
              `SELECT label FROM ticket_field_options WHERE tenant_id = $1 AND field = 'status' AND is_default LIMIT 1`,
              [tenant.id]
            ),
          ]);
          // Tout entrant Instagram par défaut en catégorie "Influence" (canal
          // principal d'approche, voir PLAN-ARCHITECTURE section 3.2) —
          // reclassable ensuite à la main comme n'importe quel ticket.
          const category = (defaultCategoryRows[0] && defaultCategoryRows[0].label) || 'Influence';
          const status = (defaultStatusRows[0] && defaultStatusRows[0].label) || 'a_traiter';

          // Correctif 2026-09-15 (6e passage), demandé par Luc ("est-ce
          // qu'on peut lier directement le profil instagram ? pour tous les
          // contacts ?") : plutôt que d'obliger à chercher/créer le profil
          // influence à la main depuis chaque ticket, on le lie
          // automatiquement dès la création du ticket, à partir du handle
          // Instagram du contact (find-or-create, voir lib/influence.js).
          // Si le contact n'a pas de username exploitable, on laisse
          // influence_relation_id à NULL comme avant — rien ne casse.
          const autoRelationId = contactParticipant.username
            ? await findOrCreateInfluenceRelation(client, tenant.id, contactParticipant.username, contactParticipant.username)
            : null;

          const { rows: insertedTicketRows } = await client.query(
            `INSERT INTO tickets (tenant_id, channel, category, status, contact_handle, external_thread_id, influence_relation_id)
             VALUES ($1, 'instagram', $2, $3, $4, $5, $6) RETURNING *`,
            [tenant.id, category, status, contactParticipant.username || null, contactParticipant.id, autoRelationId]
          );
          ticket = insertedTicketRows[0];
          summary.tickets_created += 1;
          await logAudit(client, tenant.id, {
            actor: 'system:instagram-sync',
            action: 'ticket_created',
            entityType: 'ticket',
            entityId: ticket.id,
            details: { via: 'sync_instagram', external_thread_id: contactParticipant.id, auto_linked_influence: !!autoRelationId },
          });
        }

        // Correctif 2026-09-15 (date affichée dans la liste des tickets) :
        // avant ce correctif, `UPDATE tickets SET updated_at = now()` était
        // exécuté ici pour CHAQUE conversation scannée, même quand aucun
        // message n'y était réellement nouveau — donc tous les tickets d'un
        // même sondage se retrouvaient avec exactement le même updated_at
        // (l'heure du sondage), ce qui expliquait l'heure identique "19:34"
        // sur tous les tickets dans la liste, sans rapport avec le moment où
        // un message a vraiment été envoyé/reçu. On ne touche désormais
        // updated_at que si au moins un message a réellement été inséré pour
        // ce ticket, et on le pose à la date du DERNIER message importé
        // (pas à "now()") pour qu'il reflète le vrai moment de l'échange.
        let insertedForTicket = 0;
        const textesEntrants = [];
        let latestMessageAt = null;
        // Troisième parade : UNE requête pour savoir quels messages sont déjà
        // connus, au lieu d'une par message. Sur une conversation de trente
        // messages, c'est vingt-neuf allers-retours économisés.
        const { rows: connus } = await client.query(
          `SELECT external_message_id FROM ticket_messages
            WHERE tenant_id = $1 AND external_message_id = ANY($2::text[])`,
          [tenant.id, messages.map((m) => m.id)]
        );
        const dejaImportes = new Set(connus.map((r) => r.external_message_id));

        for (const message of messages) {
          if (dejaImportes.has(message.id)) continue; // sondage idempotent

          const isFromBusiness = !!(
            message.from &&
            businessParticipantId &&
            message.from.id === businessParticipantId
          );
          const direction = isFromBusiness ? 'outbound' : 'inbound';
          // Exception assumée au workflow draft -> validated -> sent : un
          // message sortant vu ici a déjà été envoyé ailleurs (ex. réponse
          // manuelle depuis Meta Business Suite), on l'importe pour
          // l'historique du fil, jamais comme un nouveau brouillon à valider.
          const status = isFromBusiness ? 'sent' : 'received';

          // Correctif 2026-09-14 : colonne attachments alimentée — jusqu'ici
          // l'INSERT ne posait jamais cette colonne (elle retombait donc sur
          // son défaut '[]'::jsonb), y compris pour un message contenant
          // réellement une image ou une vidéo, faute pour instagram-read.js
          // de demander ce champ à l'API (voir correctif dans ce fichier-là).
          const messageCreatedAt = message.created_time || new Date().toISOString();
          await client.query(
            // channel = 'instagram' (ajout 2026-09-17) : un ticket fusionné peut
            // mêler Instagram et e-mail, chaque message garde son canal.
            `INSERT INTO ticket_messages (tenant_id, ticket_id, direction, status, body, external_message_id, created_at, attachments, channel)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'instagram')`,
            [
              tenant.id,
              ticket.id,
              direction,
              status,
              message.message || '',
              message.id,
              messageCreatedAt,
              JSON.stringify(message.attachments || []),
            ]
          );
          summary.messages_created += 1;
          insertedForTicket += 1;
          if (direction === 'inbound' && message.message) textesEntrants.push(message.message);
          if (!latestMessageAt || new Date(messageCreatedAt) > new Date(latestMessageAt)) {
            latestMessageAt = messageCreatedAt;
          }
        }

        // Date d'activité vue chez Meta : c'est elle qui permet d'ignorer
        // cette conversation au prochain passage si rien n'a bougé.
        if (conversation.updated_time) {
          await client.query(
            `UPDATE tickets SET ig_conversation_updated_at = $2 WHERE id = $1 AND tenant_id = $3`,
            [ticket.id, conversation.updated_time, tenant.id]
          );
        }

        if (insertedForTicket > 0) {
          await client.query(`UPDATE tickets SET updated_at = $2 WHERE id = $1`, [ticket.id, latestMessageAt]);
          // Un ticket archivé AUTOMATIQUEMENT parce qu'il était vide revient
          // dans la boîte dès qu'un message lisible arrive. Un ticket archivé
          // par Luc, lui, reste archivé : c'est sa décision.
          await client.query(
            `UPDATE tickets SET archived_at = NULL, archived_reason = NULL
              WHERE id = $1 AND tenant_id = $2 AND archived_reason = 'vide'
                AND EXISTS (
                  SELECT 1 FROM ticket_messages m
                   WHERE m.ticket_id = $1 AND m.tenant_id = $2
                     AND (coalesce(btrim(m.body), '') <> ''
                          OR jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0)
                )`,
            [ticket.id, tenant.id]
          );
          // Ajout 2026-09-18 : si la cliente a écrit son numéro de commande,
          // on le rattache au ticket tout de suite, après vérification chez
          // Shopify. Luc ouvre un ticket déjà documenté au lieu d'aller
          // chercher la commande à la main.
          try {
            const lien = await autoLinkOrder(client, tenant, ticket, textesEntrants.join('\n'));
            if (lien) {
              summary.orders_linked = (summary.orders_linked || 0) + 1;
              // Ajout 2026-09-18 : la commande donne l'e-mail de la cliente,
              // l'e-mail donne ses éventuelles conversations Gmail — qu'on
              // réunit ici dans une seule timeline.
              const fusion = await linkEmailAndMerge(client, tenant, { ...ticket, related_order_number: lien.order_number });
              if (fusion && fusion.merged.length) {
                summary.conversations_merged = (summary.conversations_merged || 0) + fusion.merged.length;
              }
            }
          } catch (err) {
            console.error('[commande] rattachement automatique impossible :', String(err.message || err).slice(0, 200));
          }

          // Ajout 2026-09-18, demandé par Luc : « si on n'a pas la possibilité
          // de voir les messages, autant qu'ils soient archivés directement ».
          // Un DM sans texte ni pièce jointe — réaction, partage, réponse à
          // une story — n'a rien à traiter et encombrait la boîte (cas
          // @ameliepenhoat). On l'archive, sans rien supprimer : il
          // réapparaîtra au premier message lisible, puisque la synchro
          // désarchive un ticket qui reçoit du contenu.
          //
          // Prudences : jamais un ticket déjà travaillé (analysé, catégorisé
          // à la main, commande liée, réponse envoyée ou brouillon en cours).
          const { rows: hygiene } = await client.query(
            `UPDATE tickets t SET archived_at = now(), archived_reason = 'vide', updated_at = now()
              WHERE t.id = $1 AND t.tenant_id = $2
                AND t.archived_at IS NULL
                AND t.ai_analyzed_at IS NULL
                AND t.related_order_number IS NULL
                AND t.influence_relation_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM ticket_messages m
                   WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id
                     AND (m.direction = 'outbound'
                          OR coalesce(btrim(m.body), '') <> ''
                          OR jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0)
                )
              RETURNING t.id`,
            [ticket.id, tenant.id]
          );
          if (hygiene[0]) {
            summary.archived_empty = (summary.archived_empty || 0) + 1;
            await logAudit(client, tenant.id, {
              actor: 'systeme',
              action: 'ticket_archived_empty',
              entityType: 'ticket',
              entityId: ticket.id,
              details: { raison: 'aucun message lisible (réaction, partage ou réponse à une story)' },
            });
          }
        }
      });
    } catch (err) {
      summary.errors.push({ conversation_id: conversation.id, error: err.message });
    }
  }

  sendJson(res, 200, summary);
});
