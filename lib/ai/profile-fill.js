// lib/ai/profile-fill.js
// Ajout 2026-09-18, demandé par Luc : « Une fois que l'influenceuse donne son
// adresse e-mail, ce serait bien qu'on l'enregistre aussi dans sa fiche afin
// de la compléter, avec sa pointure aussi et son adresse. »
//
// Jusqu'ici, les coordonnées données dans une conversation atterrissaient
// dans `tickets.ai_analysis.shipping_details` — utile pour préparer l'envoi
// du jour, invisible ensuite. À la collaboration suivante, il fallait tout
// redemander à quelqu'un qui l'avait déjà donné.
//
// Ici, ces informations remontent dans la fiche du compte influence
// (`influence_accounts`), qui est la personne — pas le ticket, pas la marque.
//
// Trois principes :
// - on ne remplit qu'à partir de ce que la personne a ÉCRIT (shipping_details
//   et la pointure du modèle choisi), jamais d'une déduction ;
// - un champ vide se remplit en silence ; un champ qui change est mis à jour
//   ET l'ancienne valeur est conservée dans le journal d'audit — une
//   influenceuse déménage, la dernière adresse donnée fait foi, mais rien
//   n'est perdu ;
// - jamais d'écrasement par une valeur vide : Alice qui « oublie » un champ
//   ne doit pas effacer ce que Luc a saisi à la main.

const { logAudit } = require('../audit');

// Champ de la fiche ← chemin dans l'analyse.
const FIELDS = [
  ['email', (a) => a.shipping_details?.email],
  ['address', (a) => a.shipping_details?.address],
  ['postal_code', (a) => a.shipping_details?.postal_code],
  ['city', (a) => a.shipping_details?.city],
  ['country', (a) => a.shipping_details?.country],
  ['phone', (a) => a.shipping_details?.phone],
  // La pointure vient du modèle choisi, pas des coordonnées.
  ['shoe_size', (a) => (Array.isArray(a.requested_items) ? a.requested_items : [])
    .map((it) => it && it.size).find((s) => s != null && String(s).trim() !== '')],
];

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 200) return null;
  return s;
}

/** Un e-mail manifestement invalide n'entre pas dans la fiche. */
function plausible(field, value) {
  if (field === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  if (field === 'postal_code') return /^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(value);
  if (field === 'phone') return (value.match(/\d/g) || []).length >= 6;
  if (field === 'shoe_size') return /^\d{2}([.,]5)?$/.test(value);
  return true;
}

/**
 * Calcule les champs à écrire. Exporté pour les tests : aucune base requise.
 * @returns {{patch: Object, remplis: string[], modifies: Array<{field, avant, apres}>}}
 */
function computeAccountPatch(account, analysis) {
  const patch = {};
  const remplis = [];
  const modifies = [];
  if (!account || !analysis) return { patch, remplis, modifies };
  for (const [field, read] of FIELDS) {
    const value = clean(read(analysis));
    if (!value || !plausible(field, value)) continue;
    const current = clean(account[field]);
    if (!current) {
      patch[field] = value;
      remplis.push(field);
    } else if (current.toLowerCase() !== value.toLowerCase()) {
      patch[field] = value;
      modifies.push({ field, avant: current, apres: value });
    }
  }
  return { patch, remplis, modifies };
}

/**
 * Complète la fiche du compte influence à partir de l'analyse.
 * Best-effort : une erreur ici ne doit jamais faire échouer l'analyse du
 * ticket, qui est le travail principal.
 * @returns {Promise<{remplis: string[], modifies: Array}|null>}
 */
async function fillAccountFromAnalysis(client, { tenant, account, analysis, ticketId, actor = 'ia' }) {
  if (!account || !account.id) return null;
  const { patch, remplis, modifies } = computeAccountPatch(account, analysis);
  const fields = Object.keys(patch);
  if (!fields.length) return null;

  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await client.query(
    `UPDATE influence_accounts SET ${sets}, updated_at = now() WHERE id = $1`,
    [account.id, ...fields.map((f) => patch[f])]
  );

  try {
    await logAudit(client, tenant.id, {
      actor,
      action: 'profile_filled_from_conversation',
      entityType: 'influence_account',
      entityId: account.id,
      details: { ticket_id: ticketId, remplis, modifies },
    });
  } catch {
    // Le journal n'est pas bloquant : la fiche est déjà à jour.
  }
  return { remplis, modifies };
}

module.exports = { fillAccountFromAnalysis, computeAccountPatch, FIELDS };
