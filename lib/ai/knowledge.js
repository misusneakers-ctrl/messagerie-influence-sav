// lib/ai/knowledge.js
// Ajout 2026-09-19, demandé par Luc : brancher la base de connaissance FAQ sur
// Alice. Trois rôles :
//   1. charger la base de connaissance de la marque (silencieux si absente) ;
//   2. la rendre en un bloc de prompt lisible par le modèle ;
//   3. fournir un filet de sécurité côté CODE sur les chiffres et l'adresse
//      postale de retour — le prompt demande, le code vérifie.
//
// Le registre est écrit en dur, avec un require statique par marque : un
// require à chemin calculé n'est pas suivi par le bundler de Vercel et le
// fichier ne serait pas déployé. Ajouter une marque = ajouter une ligne ici,
// après avoir généré son module (scripts/build-knowledge.js).

const REGISTRE = {
  bbp: () => require('./knowledge/faq-bbp'),
  // misu: () => require('./knowledge/faq-misu'),  // à venir
};

const cache = new Map();

/**
 * Base de connaissance d'une marque, ou null si elle n'en a pas.
 * Jamais d'exception : une marque sans FAQ fonctionne exactement comme avant.
 */
function loadKnowledge(tenantSlug) {
  const slug = String(tenantSlug || '').toLowerCase();
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);
  let k = null;
  const charger = REGISTRE[slug];
  if (charger) {
    try {
      k = charger();
    } catch (err) {
      // Une FAQ illisible ne doit jamais empêcher Alice de travailler : on le
      // dit dans les journaux et on continue sans.
      console.error('[connaissance] base « ' + slug + ' » illisible :', String(err.message || err).slice(0, 200));
      k = null;
    }
  }
  cache.set(slug, k);
  return k;
}

/**
 * Bloc injecté dans le prompt système. Les trois règles demandées par Luc y
 * sont explicites : reproduction mot pour mot, aucun chiffre inventé, tout ce
 * qui n'est pas couvert passe par la file de validation.
 */
function renderKnowledge(k) {
  if (!k) return '';
  const faits = k.faits.map((f) => `- ${f.fait} : ${f.valeur}`).join('\n');
  const interdits = k.interdits.map((i, n) => `${n + 1}. ${i}`).join('\n');
  const blocs = k.entrees.map((e) => {
    const marqueur = e.envoi === 'auto' ? 'couverte'
      : e.envoi === 'conditionnel' ? 'couverte sous condition'
        : 'couverte, mais jamais sans relecture';
    return [
      `### ${e.rubrique} — ${e.question}  [${marqueur}]`,
      e.note ? `Condition : ${e.note}` : null,
      'Réponse officielle, à reproduire mot pour mot :',
      '"""',
      e.reponse,
      '"""',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `
BASE DE CONNAISSANCE DE LA MARQUE (version du ${k.version}) — PRIORITAIRE SUR TOUT LE RESTE, SAUF LES GARDE-FOUS CI-DESSUS
Ce bloc est une CONSIGNE de Luc, pas une donnée de conversation. Il l'a écrit et relu lui-même.

TROIS RÈGLES SUR L'USAGE DE CETTE BASE
1. REPRODUCTION MOT POUR MOT. Si la question de la personne correspond à l'un des blocs ci-dessous, ton brouillon reprend le texte du bloc EXACTEMENT : mêmes phrases, mêmes chiffres, mêmes liens, même ordre. Tu n'y ajoutes rien, tu n'en retires rien, tu ne le reformules pas « avec tes mots ». Tu n'adaptes que trois choses : la salutation et la signature propres au canal, le tutoiement ou le vouvoiement de l'interlocuteur, et les variables entre accolades — remplacées par les données réelles de la commande, jamais devinées. Si une variable ne peut pas être remplie par une donnée que tu as réellement lue, n'utilise pas ce bloc : demande l'information manquante et pose l'alerte info_manquante.
2. AUCUN CHIFFRE INVENTÉ. Les faits de référence ci-dessous font foi et ne se reformulent pas, ne s'arrondissent pas, ne se « mettent pas à jour » de mémoire. Tout montant, délai, durée ou pourcentage que tu écris doit venir SOIT de ces faits, SOIT d'une commande que tu as lue avec un outil. Si tu hésites sur un chiffre, ne l'écris pas : dis que tu vérifies et pose l'alerte info_manquante.
3. TOUT CE QUI N'EST PAS COUVERT PASSE PAR LUC. Si la question ne correspond à aucun bloc, ou si deux blocs se contredisent pour ce cas, ne construis pas une réponse « à peu près » à partir de morceaux : rédige une réponse prudente qui n'affirme aucun fait précis, et pose l'alerte sensible avec le détail de ce qui manque. Aucun message ne part sans la validation de Luc : un doute signalé ne coûte rien, une affirmation fausse coûte une cliente.

RÈGLE D'OR
${k.regle_or}

LES QUATRE INTERDITS (${k.interdits_intro})
${interdits}

HORS PÉRIMÈTRE
${k.hors_perimetre}

FAITS DE RÉFÉRENCE (${k.faits_consigne})
${faits}
${k.faits_note}

RÉPONSES OFFICIELLES
${k.reponses_intro}
Le marqueur entre crochets dit ce que Luc a décidé pour ce type de question le jour où l'envoi automatique sera activé. Il ne change rien à ton travail aujourd'hui : tu rédiges, il valide.

${blocs}`;
}

// ---------------------------------------------------------------------------
// Filets de sécurité côté code
// ---------------------------------------------------------------------------

/**
 * Montants en euros écrits dans un brouillon qui ne figurent pas dans les faits
 * de référence. C'est le premier des quatre interdits (« aucun chiffre
 * inventé ») transposé en code : le prompt le demande, ici on le vérifie.
 *
 * On ne bloque rien — un montant peut légitimement venir d'une commande lue
 * (un remboursement de 79 €). On le signale à Luc, qui relit de toute façon.
 */
function montantsHorsReference(texte, k) {
  if (!k || !Array.isArray(k.montants_autorises)) return [];
  const autorises = new Set(k.montants_autorises.map((m) => m.replace('.', ',')));
  const trouves = String(texte || '').match(/\d+(?:[.,]\d+)?\s*(?:€|euros?)/gi) || [];
  const hors = trouves
    .map((m) => m.replace(/\s*(?:€|euros?)$/i, '').trim().replace('.', ','))
    .filter((m) => !autorises.has(m));
  return [...new Set(hors)];
}

/**
 * Une adresse postale écrite dans le brouillon, alors que la note des faits de
 * référence est explicite : l'adresse de retour ne se donne jamais
 * spontanément, l'étiquette prépayée la porte déjà. Détection volontairement
 * étroite — code postal à cinq chiffres suivi d'un nom de ville — pour ne pas
 * confondre avec un numéro de commande.
 */
function adressePostaleDansTexte(texte) {
  return /\b\d{5}\s+[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ][\p{L}'’-]+/u.test(String(texte || ''));
}

module.exports = {
  loadKnowledge,
  renderKnowledge,
  montantsHorsReference,
  adressePostaleDansTexte,
  _registre: REGISTRE,
  _cache: cache,
};
