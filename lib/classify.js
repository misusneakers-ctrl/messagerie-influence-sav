// lib/classify.js
// Tri automatique des NOUVEAUX contacts Instagram en 4 catégories, à partir
// du texte du premier message entrant : Influence / SAV / B2B / Autre.
//
// Volontairement une simple détection par mots-clés (pas d'appel IA, pas de
// dépendance externe, pas de coût, résultat déterministe et explicable) —
// suffisant pour un premier tri automatique que Luc corrige ensuite à la
// main quand besoin (le classement reste modifiable comme n'importe quel
// ticket, voir index.html). N'est utilisé qu'à la CRÉATION d'un nouveau
// ticket (voir api/tickets/sync-instagram.js) — ne reclasse jamais un
// ticket existant.
//
// Ordre de priorité en cas d'égalité de score entre catégories : SAV avant
// B2B avant Influence — un message ambigu qui pourrait être un problème SAV
// vaut mieux être vu tout de suite dans le bon onglet plutôt que noyé dans
// la file Influence.

const SAV_PATTERNS = [
  /\bcommandes?\b/,
  /\bremboursement/,
  /\bretours?\b/,
  /\breclamations?\b/,
  /\br[ée]clamations?\b/,
  /\blivraisons?\b/,
  /\bcolis\b/,
  /\bsav\b/,
  /\bprobl[eè]me/,
  /\bd[ée]fectueux/,
  /\bd[ée]faut/,
  /\bab[iî]m[ée]/,
  /\bcass[ée]/,
  /\bmauvaise taille/,
  /\béchange\b/,
  /\bechange\b/,
  /\bfacture\b/,
  /\bpas re[cç]u/,
  /\bo[uù] en est/,
  /\bsuivi de (ma )?commande/,
  /\bnuméro de commande/,
  /\bc\d{5,7}\b/, // référence de commande type C292538 / C294671
];

const B2B_PATTERNS = [
  /\brevendeurs?\b/,
  /\bprofessionnels?\b/,
  /\bb2b\b/,
  /\bgrossistes?\b/,
  /\bboutiques?\b/,
  /\bmagasins?\b/,
  /\bdistribution\b/,
  /\bdistributeurs?\b/,
  /\bachat(s)? en gros\b/,
  /\bcollaboration commerciale\b/,
  /\bpartenariat commercial\b/,
  /\bfournisseurs?\b/,
  /\bsiret\b/,
  /\bentreprises?\b/,
  /\bwholesale\b/,
  /\bcommande groupée\b/,
  /\btarifs? pro(fessionnels?)?\b/,
];

const INFLUENCE_PATTERNS = [
  /\bpartenariats?\b/,
  /\bcollaborations?\b/,
  /\babonn[ée]s\b/,
  /\bfollowers?\b/,
  /\baudience\b/,
  /\bcompte instagram\b/,
  /\bcommunaut[ée]\b/,
  /\bambassadrice?s?\b/,
  /\baffiliations?\b/,
  /\bcode promo\b/,
  /\bstor(y|ies)\b/,
  /\binfluenceur(se)?s?\b/,
  /\bcr[ée]ateur(rice)?s? de contenu\b/,
  /\bpost(er|ing)?\b/,
  /\bmentionn(er|ant)\b/,
  /\bvues? par mois\b/,
  /\bengagement\b/,
];

function scoreFor(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function classifyContact(text) {
  const t = (text || '').toLowerCase();
  const scores = [
    ['SAV', scoreFor(t, SAV_PATTERNS)],
    ['B2B', scoreFor(t, B2B_PATTERNS)],
    ['Influence', scoreFor(t, INFLUENCE_PATTERNS)],
  ];
  const [bestLabel, bestScore] = scores.sort((a, b) => b[1] - a[1])[0];
  return bestScore > 0 ? bestLabel : 'Autre';
}

module.exports = { classifyContact };
