// lib/ai/investigation.js
// Ajout 2026-09-17, demandé par Luc : « est-ce qu'Alice, avant d'apporter une
// réponse, est capable d'aller chercher du contexte, voire investiguer ? […]
// retrouver le numéro de commande […] en allant chercher son nom et son prénom
// sur sa bio […] pour essayer de merger le ticket ».
//
// Outils de CONSULTATION mis à disposition d'Alice (bouton « ✨ Préparer une
// réponse » uniquement) — tous en lecture seule :
// - rechercher_commandes   : commandes Shopify (nom, e-mail, n°, période…)
// - lire_commande          : détail d'une commande (articles, suivi, retour)
// - rechercher_conversations : autres tickets de la messagerie (même marque)
// - rechercher_emails      : boîte Gmail SAV connectée (gmail.readonly)
// - profil_instagram_contact : nom affiché / bio du compte Instagram du contact
//
// Alice ne rattache RIEN elle-même : elle rend des candidats avec indices et
// niveau de confiance ; Luc clique « Lier la commande » / « Fusionner ».
// Les numéros de commande et identifiants de tickets qu'elle cite sont
// revérifiés côté serveur (voir sanitizeInvestigation) : seuls ceux
// réellement renvoyés par les outils pendant l'analyse sont conservés.
const { withTenant } = require('../db');
const { decrypt } = require('../crypto');
const { getOrderContext } = require('../channels/shopify-readonly');
const { searchEmails } = require('../gmail/client');

const SHOPIFY_API_VERSION = '2025-10';
const CONFIDENCES = ['forte', 'moyenne', 'faible'];

// ---------------------------------------------------------------------------
// Shopify (jeton lecture seule 'shopify_readonly' déjà utilisé par le SAV)
// ---------------------------------------------------------------------------

async function loadShopifyReadonlyToken(tenant) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value FROM tenant_credentials WHERE tenant_id = $1 AND type = 'shopify_readonly'`,
      [tenant.id]
    );
    return rows[0] ? decrypt(rows[0].encrypted_value) : null;
  });
}

async function shopifyGraphql(tenant, token, query, variables) {
  const resp = await fetch(`https://${tenant.myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`shopify_http_${resp.status}`);
    err.code = 'shopify_read_failed';
    throw err;
  }
  return json;
}

const ORDER_FIELDS_FULL = `
  name createdAt cancelledAt email phone
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress { name city zip countryCodeV2 }
  billingAddress { name }
  lineItems(first: 10) { nodes { title variantTitle sku quantity } }
`;
// Repli si la boutique refuse les données clients protégées pour ce jeton.
const ORDER_FIELDS_MIN = `
  name createdAt cancelledAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 10) { nodes { title variantTitle sku quantity } }
`;

function frDate(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function compactOrder(o) {
  return {
    numero: o.name,
    date: frDate(o.createdAt),
    date_iso: o.createdAt,
    annulee: !!o.cancelledAt,
    paiement: o.displayFinancialStatus || null,
    expedition: o.displayFulfillmentStatus || null,
    total: o.totalPriceSet ? `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}` : null,
    email: o.email || null,
    telephone: o.phone || null,
    nom_livraison: o.shippingAddress ? o.shippingAddress.name : null,
    ville_livraison: o.shippingAddress ? [o.shippingAddress.zip, o.shippingAddress.city, o.shippingAddress.countryCodeV2].filter(Boolean).join(' ') : null,
    nom_facturation: o.billingAddress ? o.billingAddress.name : null,
    articles: ((o.lineItems && o.lineItems.nodes) || []).map((li) => [li.quantity > 1 ? `${li.quantity}×` : '', li.title, li.variantTitle ? `(${li.variantTitle})` : '', li.sku ? `[${li.sku}]` : ''].filter(Boolean).join(' ')),
  };
}

function normalizeOrderNumber(value) {
  return String(value || '').trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase();
}

function quote(value) {
  return `"${String(value).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/** Construit la requête de recherche Shopify à partir des critères d'Alice. */
function buildOrderSearch(input) {
  const parts = [];
  if (input.numero) {
    const n = normalizeOrderNumber(input.numero);
    parts.push(/^\d+$/.test(n) ? n : `name:${n}`);
  }
  // e-mail entre guillemets = correspondance exacte (champ « tokenisé » côté Shopify)
  if (input.email) parts.push(`email:${quote(String(input.email).trim())}`);
  if (input.nom) parts.push(quote(input.nom));
  if (input.telephone) parts.push(quote(String(input.telephone).replace(/[^\d+]/g, '')));
  if (input.depuis) parts.push(`created_at:>=${String(input.depuis).slice(0, 10)}`);
  if (input.jusqu_a) parts.push(`created_at:<=${String(input.jusqu_a).slice(0, 10)}`);
  return parts.join(' ');
}

function createShopifyTools(tenant) {
  let tokenPromise = null;
  let scopesPromise = null;
  const token = () => (tokenPromise = tokenPromise || loadShopifyReadonlyToken(tenant));
  const scopes = async () => {
    scopesPromise = scopesPromise || (async () => {
      try {
        const json = await shopifyGraphql(tenant, await token(), '{ currentAppInstallation { accessScopes { handle } } }');
        return ((json.data && json.data.currentAppInstallation && json.data.currentAppInstallation.accessScopes) || []).map((s) => s.handle);
      } catch {
        return null;
      }
    })();
    return scopesPromise;
  };

  async function searchOrders(input) {
    const t = await token();
    if (!t) return { error: 'shopify_lecture_non_connecte' };
    const search = buildOrderSearch(input || {});
    if (!search) return { error: 'aucun_critere', aide: 'Donne au moins un critère : numero, email, nom, telephone, ou une période.' };
    const run = (fields) => shopifyGraphql(tenant, t,
      `query($q: String!) { orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $q) { nodes { ${fields} } } }`, { q: search });
    let json = await run(ORDER_FIELDS_FULL);
    let limited = false;
    if (json.errors && !json.data) {
      json = await run(ORDER_FIELDS_MIN);
      limited = true;
    }
    if (json.errors && !json.data) return { error: 'recherche_refusee_par_shopify', detail: JSON.stringify(json.errors).slice(0, 300) };
    let orders = ((json.data && json.data.orders && json.data.orders.nodes) || []).map(compactOrder);
    if (input.produit) {
      const needle = String(input.produit).toLowerCase();
      const words = needle.split(/\s+/).filter((w) => w.length > 2);
      const matching = orders.filter((o) => o.articles.some((a) => words.every((w) => a.toLowerCase().includes(w))));
      if (matching.length) orders = matching;
    }
    const granted = await scopes();
    const out = { requete_shopify: search, nombre: orders.length, commandes: orders };
    if (limited) out.note = 'Noms, e-mails et adresses non lisibles avec ce jeton : rapprochement par date et articles uniquement.';
    if (granted && !granted.includes('read_all_orders')) {
      out.limite = 'Seules les commandes des 60 derniers jours sont visibles (droit read_all_orders absent).';
    }
    return out;
  }

  async function readOrder(input) {
    const t = await token();
    if (!t) return { error: 'shopify_lecture_non_connecte' };
    const numero = normalizeOrderNumber(input && input.numero);
    if (!numero) return { error: 'numero_requis' };
    const found = await searchOrders({ numero });
    const exact = (found.commandes || []).find((o) => normalizeOrderNumber(o.numero) === numero || normalizeOrderNumber(o.numero).endsWith(numero));
    if (!exact) return { error: 'commande_introuvable', numero };
    let context = null;
    try {
      context = await getOrderContext({ shopDomain: tenant.myshopify_domain, accessToken: t, orderNumber: exact.numero, tenantSlug: tenant.slug });
    } catch (err) {
      context = { erreur_detail: err.message };
    }
    return {
      commande: exact,
      suivi: context && context.tracking ? context.tracking : [],
      retour: context ? {
        statut: context.return_status || null,
        etiquette: context.return_label || null,
        echange: context.exchange_order || null,
        retours: context.returns || undefined,
      } : null,
      note_commande: context ? context.notes : null,
    };
  }

  return { searchOrders, readOrder };
}

// ---------------------------------------------------------------------------
// Autres conversations de la messagerie (même marque uniquement)
// ---------------------------------------------------------------------------

async function searchConversations(tenant, currentTicketId, input) {
  const terms = [];
  const params = [tenant.id, currentTicketId];
  const like = (v) => {
    params.push(`%${String(v).trim().replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    return `$${params.length}`;
  };
  if (input.email) {
    const p = like(input.email);
    terms.push(`t.contact_email ILIKE ${p}`);
    terms.push(`EXISTS (SELECT 1 FROM ticket_messages mm WHERE mm.ticket_id = t.id AND mm.tenant_id = t.tenant_id AND mm.body ILIKE ${p})`);
  }
  if (input.nom) {
    const p = like(input.nom);
    terms.push(`t.contact_name ILIKE ${p}`);
    terms.push(`ia.display_name ILIKE ${p}`);
  }
  if (input.pseudo) {
    const p = like(String(input.pseudo).replace(/^@/, ''));
    terms.push(`t.contact_handle ILIKE ${p}`);
  }
  if (input.numero_commande) {
    const p = like(normalizeOrderNumber(input.numero_commande).replace(/^[A-Z]+/, ''));
    terms.push(`t.related_order_number ILIKE ${p}`);
    terms.push(`EXISTS (SELECT 1 FROM ticket_messages mm WHERE mm.ticket_id = t.id AND mm.tenant_id = t.tenant_id AND mm.body ILIKE ${p})`);
  }
  if (input.texte) {
    const p = like(input.texte);
    terms.push(`EXISTS (SELECT 1 FROM ticket_messages mm WHERE mm.ticket_id = t.id AND mm.tenant_id = t.tenant_id AND mm.body ILIKE ${p})`);
  }
  if (!terms.length) return { error: 'aucun_critere' };

  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.channel, t.category, t.status, t.contact_name, t.contact_handle, t.contact_email,
              t.related_order_number, t.created_at, t.archived_at, t.merged_into_ticket_id,
              ia.display_name AS profil_nom,
              (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id) AS nb_messages,
              (SELECT json_agg(x ORDER BY x.at) FROM (
                 SELECT m.direction, left(m.body, 300) AS body, COALESCE(m.sent_at, m.created_at) AS at
                 FROM ticket_messages m
                 WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id AND (m.direction = 'inbound' OR m.status = 'sent')
                 ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT 4) x) AS derniers_messages
       FROM tickets t
       LEFT JOIN tenant_influence_relations r ON r.id = t.influence_relation_id AND r.tenant_id = t.tenant_id
       LEFT JOIN influence_accounts ia ON ia.id = r.account_id
       WHERE t.tenant_id = $1 AND t.id <> $2
         AND (t.merged_into_ticket_id IS NULL OR t.merged_into_ticket_id <> $2)
         AND (${terms.join(' OR ')})
       ORDER BY t.created_at DESC
       LIMIT 8`,
      params
    );
    return {
      nombre: rows.length,
      conversations: rows.map((r) => ({
        ticket_id: r.id,
        canal: r.channel,
        categorie: r.category,
        statut: r.status,
        contact: [r.contact_name, r.profil_nom, r.contact_handle && '@' + r.contact_handle, r.contact_email].filter(Boolean).join(' · ') || null,
        commande_liee: r.related_order_number || null,
        creee_le: frDate(r.created_at),
        archivee: !!r.archived_at,
        deja_fusionnee: !!r.merged_into_ticket_id,
        nb_messages: r.nb_messages,
        derniers_messages: (r.derniers_messages || []).map((m) => `[${frDate(m.at)}] ${m.direction === 'inbound' ? 'CONTACT' : 'MARQUE'} : ${m.body}`),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Profil Instagram du contact (nom affiché + bio si compte pro public)
// ---------------------------------------------------------------------------

async function instagramContactProfile(tenant, ticket) {
  if (ticket.channel !== 'instagram' || !ticket.external_thread_id) return { error: 'pas_une_conversation_instagram' };
  const creds = await withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT type, encrypted_value, metadata FROM tenant_credentials
       WHERE tenant_id = $1 AND type IN ('meta_instagram', 'meta_business_discovery')`,
      [tenant.id]
    );
    return Object.fromEntries(rows.map((r) => [r.type, r]));
  });
  const out = { pseudo: ticket.contact_handle || null };

  if (creds.meta_instagram) {
    try {
      const url = new URL(`https://graph.instagram.com/v21.0/${encodeURIComponent(ticket.external_thread_id)}`);
      url.searchParams.set('fields', 'name,username');
      url.searchParams.set('access_token', decrypt(creds.meta_instagram.encrypted_value));
      const resp = await fetch(url);
      const json = await resp.json().catch(() => ({}));
      if (resp.ok) {
        out.nom_affiche = json.name || null;
        out.pseudo = json.username || out.pseudo;
      } else {
        out.nom_affiche_erreur = (json.error && json.error.message) || `http_${resp.status}`;
      }
    } catch (err) {
      out.nom_affiche_erreur = err.message;
    }
  }

  const handle = out.pseudo && String(out.pseudo).replace(/^@/, '');
  const bd = creds.meta_business_discovery;
  if (handle && bd && bd.metadata && bd.metadata.ig_business_account_id && /^[A-Za-z0-9._]+$/.test(handle)) {
    try {
      const url = new URL(`https://graph.facebook.com/v21.0/${bd.metadata.ig_business_account_id}`);
      url.searchParams.set('fields', `business_discovery.username(${handle}){name,biography,website}`);
      url.searchParams.set('access_token', decrypt(bd.encrypted_value));
      const resp = await fetch(url);
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json.business_discovery) {
        out.nom_profil = json.business_discovery.name || null;
        out.bio = json.business_discovery.biography || null;
        out.site = json.business_discovery.website || null;
      } else {
        out.bio_indisponible = 'compte privé ou non professionnel : bio non lisible';
      }
    } catch {
      out.bio_indisponible = 'erreur de lecture';
    }
  }
  out.rappel = "Un nom affiché Instagram peut être un surnom : c'est au mieux un indice faible.";
  return out;
}

// ---------------------------------------------------------------------------
// Définitions d'outils + handlers pour la boucle Claude
// ---------------------------------------------------------------------------

const INVESTIGATION_TOOLS = [
  {
    name: 'rechercher_commandes',
    description: "Cherche des commandes dans la boutique Shopify de la marque (lecture seule). Combine les critères connus ; relance avec d'autres critères si besoin (nom complet puis nom de famille seul, e-mail, période).",
    input_schema: {
      type: 'object',
      properties: {
        numero: { type: 'string', description: 'Numéro de commande, ex. « C294902 » ou « 294902 »' },
        email: { type: 'string' },
        nom: { type: 'string', description: 'Prénom et/ou nom du client' },
        telephone: { type: 'string' },
        produit: { type: 'string', description: 'Modèle évoqué, pour filtrer les résultats, ex. « Ava camel »' },
        depuis: { type: 'string', description: 'Date AAAA-MM-JJ' },
        jusqu_a: { type: 'string', description: 'Date AAAA-MM-JJ' },
      },
    },
  },
  {
    name: 'lire_commande',
    description: 'Lit le détail d\'une commande Shopify : articles, statut de paiement et d\'expédition, suivi transporteur, retour éventuel.',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'string' } },
      required: ['numero'],
    },
  },
  {
    name: 'rechercher_conversations',
    description: 'Cherche d\'autres conversations de la messagerie de la marque (Instagram, e-mail) avec le même client.',
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string' }, email: { type: 'string' }, pseudo: { type: 'string', description: 'Pseudo Instagram' },
        numero_commande: { type: 'string' }, texte: { type: 'string', description: 'Mot ou expression présent dans les messages' },
      },
    },
  },
  {
    name: 'rechercher_emails',
    description: 'Cherche dans la boîte e-mail SAV de la marque (lecture seule), avec la syntaxe de recherche Gmail : from:adresse, subject:mot, "C294902", after:2026/08/01, before:2026/09/15.',
    input_schema: {
      type: 'object',
      properties: { requete: { type: 'string' } },
      required: ['requete'],
    },
  },
  {
    name: 'profil_instagram_contact',
    description: 'Lit le nom affiché et, si le compte est professionnel et public, la bio Instagram du contact de cette conversation.',
    input_schema: { type: 'object', properties: {} },
  },
];

function createInvestigationHandlers(tenant, ctx) {
  const shop = createShopifyTools(tenant);
  return {
    rechercher_commandes: (input) => shop.searchOrders(input),
    lire_commande: (input) => shop.readOrder(input),
    rechercher_conversations: (input) => searchConversations(tenant, ctx.ticket.id, input || {}),
    rechercher_emails: async (input) => {
      try {
        return await searchEmails(tenant, { query: input && input.requete });
      } catch (err) {
        if (err.code === 'gmail_not_connected' || err.code === 'gmail_app_not_configured') {
          return { error: 'boite_email_non_connectee' };
        }
        return { error: err.code || 'recherche_email_en_erreur' };
      }
    },
    profil_instagram_contact: () => instagramContactProfile(tenant, ctx.ticket),
  };
}

const INVESTIGATION_SCHEMA = {
  type: 'object',
  description: "Résultat de l'enquête (uniquement si tu as utilisé les outils de recherche). Cite des indices précis renvoyés par les outils, jamais inventés.",
  properties: {
    conclusion: { type: 'string', description: 'Une ou deux phrases pour Luc.' },
    commandes: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          numero: { type: 'string' },
          confiance: { type: 'string', enum: CONFIDENCES },
          indices: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        },
        required: ['numero', 'confiance', 'indices'],
      },
    },
    conversations: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string' },
          confiance: { type: 'string', enum: CONFIDENCES },
          indices: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        },
        required: ['ticket_id', 'confiance', 'indices'],
      },
    },
    emails: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { email_id: { type: 'string' }, resume: { type: 'string' } },
        required: ['email_id', 'resume'],
      },
    },
  },
};

/**
 * Ne garde que les commandes / conversations / e-mails RÉELLEMENT renvoyés
 * par les outils pendant cette analyse, et complète chaque candidat avec les
 * données exactes de l'outil (date, nom, articles…) pour l'affichage.
 */
function sanitizeInvestigation(raw, toolCalls, ticket) {
  const seenOrders = new Map();
  const seenTickets = new Map();
  const seenEmails = new Map();
  const searches = [];
  for (const call of toolCalls || []) {
    const out = call.output || {};
    if (['rechercher_commandes', 'lire_commande', 'rechercher_conversations', 'rechercher_emails', 'profil_instagram_contact'].includes(call.name)) {
      searches.push({ outil: call.name, criteres: call.input || {}, resultats: out.nombre ?? (out.emails ? out.emails.length : (out.commande ? 1 : undefined)), erreur: out.error || undefined });
    }
    (out.commandes || []).forEach((o) => seenOrders.set(normalizeOrderNumber(o.numero), o));
    if (out.commande) seenOrders.set(normalizeOrderNumber(out.commande.numero), { ...out.commande, suivi: out.suivi, retour: out.retour });
    (out.conversations || []).forEach((c) => seenTickets.set(String(c.ticket_id), c));
    (out.emails || []).forEach((e) => seenEmails.set(String(e.email_id), e));
  }
  if (!raw && !searches.length) return null;
  const r = raw || {};
  const conf = (c) => (CONFIDENCES.includes(c) ? c : 'faible');
  const indices = (list) => (Array.isArray(list) ? list : []).map((s) => String(s).slice(0, 200)).slice(0, 6);
  const linked = normalizeOrderNumber(ticket.related_order_number);

  const commandes = [];
  (Array.isArray(r.commandes) ? r.commandes : []).forEach((c) => {
    const key = normalizeOrderNumber(c && c.numero);
    const found = seenOrders.get(key) || [...seenOrders.entries()].find(([k]) => key && k.endsWith(key))?.[1];
    if (!found || commandes.some((x) => normalizeOrderNumber(x.numero) === normalizeOrderNumber(found.numero))) return;
    commandes.push({
      numero: found.numero,
      confiance: conf(c.confiance),
      indices: indices(c.indices),
      date: found.date,
      nom: found.nom_livraison || found.nom_facturation || null,
      ville: found.ville_livraison || null,
      articles: (found.articles || []).slice(0, 5),
      expedition: found.expedition || null,
      annulee: !!found.annulee,
      deja_liee: !!linked && normalizeOrderNumber(found.numero) === linked,
    });
  });

  const conversations = [];
  (Array.isArray(r.conversations) ? r.conversations : []).forEach((c) => {
    const found = seenTickets.get(String(c && c.ticket_id));
    if (!found || conversations.some((x) => x.ticket_id === found.ticket_id)) return;
    conversations.push({
      ticket_id: found.ticket_id,
      confiance: conf(c.confiance),
      indices: indices(c.indices),
      canal: found.canal,
      contact: found.contact,
      creee_le: found.creee_le,
      commande_liee: found.commande_liee,
      archivee: found.archivee,
      deja_fusionnee: found.deja_fusionnee,
    });
  });

  const emails = [];
  (Array.isArray(r.emails) ? r.emails : []).forEach((e) => {
    const found = seenEmails.get(String(e && e.email_id));
    if (!found || emails.some((x) => x.email_id === found.email_id)) return;
    emails.push({ email_id: found.email_id, date: found.date, de: found.de, sujet: found.sujet, resume: String(e.resume || '').slice(0, 300) });
  });

  const rank = { forte: 0, moyenne: 1, faible: 2 };
  commandes.sort((a, b) => rank[a.confiance] - rank[b.confiance]);
  conversations.sort((a, b) => rank[a.confiance] - rank[b.confiance]);

  return {
    conclusion: String(r.conclusion || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null,
    commandes,
    conversations,
    emails,
    recherches: searches.slice(0, 12),
  };
}

module.exports = {
  INVESTIGATION_TOOLS,
  INVESTIGATION_SCHEMA,
  createInvestigationHandlers,
  sanitizeInvestigation,
  buildOrderSearch,
  normalizeOrderNumber,
  searchConversations,
};
