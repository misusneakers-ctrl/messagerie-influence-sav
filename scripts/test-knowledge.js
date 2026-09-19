#!/usr/bin/env node
// scripts/test-knowledge.js
// Tests de la base de connaissance branchée sur Alice (19/09/2026).
// Aucune dépendance, aucun accès réseau, aucune base : on teste les modules
// en direct.
//
//   node scripts/test-knowledge.js
//
// lib/db.js exige DATABASE_URL au chargement (sans jamais se connecter à ce
// moment-là) : on pose donc une valeur factice si elle manque, uniquement pour
// que le require aboutisse. Aucune requête n'est exécutée par ces tests.
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test_sans_connexion';

const fs = require('fs');
const path = require('path');

const knowledge = require('../lib/ai/knowledge');
const { _internal } = require('../lib/ai/assistant');

let echecs = 0;
let reussites = 0;

function verifie(titre, condition, detail) {
  if (condition) {
    reussites += 1;
    console.log('  ok   ' + titre);
  } else {
    echecs += 1;
    console.log('  ÉCHEC ' + titre + (detail ? '\n        → ' + detail : ''));
  }
}

function groupe(nom) {
  console.log('\n' + nom);
}

// ---------------------------------------------------------------------------
// 1. Fidélité du module généré à la source markdown
// ---------------------------------------------------------------------------

groupe('1. Fidélité au markdown relu par Luc');

const SOURCE = path.join(__dirname, '..', 'lib', 'ai', 'knowledge', 'faq-bbp.source.md');
const md = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n?/g, '\n');
const k = knowledge.loadKnowledge('bbp');

verifie('la base bbp se charge', !!k);
verifie('29 réponses extraites', k.entrees.length === 29, 'trouvé ' + k.entrees.length);
verifie('12 faits de référence', k.faits.length === 12, 'trouvé ' + k.faits.length);
verifie('4 interdits', k.interdits.length === 4);
verifie('version renseignée', k.version === '18/09/2026', String(k.version));

const infideles = k.entrees.filter((e) => !md.includes(e.reponse));
verifie('chaque réponse figure MOT POUR MOT dans la source',
  infideles.length === 0,
  infideles.map((e) => e.question).join(' | '));

const faitsAbsents = k.faits.filter((f) => !md.includes(f.fait) || !md.includes(f.valeur));
verifie('chaque fait de référence figure tel quel dans la source', faitsAbsents.length === 0,
  faitsAbsents.map((f) => f.fait).join(' | '));

verifie('aucun filet horizontal « --- » avalé dans un texte',
  !k.faits_note.includes('---') && !k.hors_perimetre.includes('---') && !k.regle_or.includes('---'),
  JSON.stringify(k.faits_note.slice(-20)));

verifie('les modes d\'envoi sont reconnus (23 auto, 3 conditionnels, 3 jamais)',
  k.entrees.filter((e) => e.envoi === 'auto').length === 23
  && k.entrees.filter((e) => e.envoi === 'conditionnel').length === 3
  && k.entrees.filter((e) => e.envoi === 'jamais').length === 3,
  JSON.stringify(k.entrees.reduce((a, e) => { a[e.envoi] = (a[e.envoi] || 0) + 1; return a; }, {})));

verifie('les variables du bloc « suivre ma commande » sont repérées',
  k.entrees.some((e) => e.variables.includes('{numero_suivi}') && e.variables.includes('{lien_suivi}')));

verifie('aucune réponse ne contient de marqueur markdown résiduel',
  k.entrees.every((e) => !/^\s*(\*\*|```|####)/m.test(e.reponse)));

verifie('montants de référence : 2,90 / 4,90 / 5,90 / 100',
  ['100', '2,90', '4,90', '5,90'].every((m) => k.montants_autorises.includes(m)),
  k.montants_autorises.join(' '));

// Le générateur doit être idempotent : régénérer ne doit rien changer.
const { construire } = require('./build-knowledge');
const genere = path.join(__dirname, '..', 'lib', 'ai', 'knowledge', 'faq-bbp.js');
const avant = fs.readFileSync(genere, 'utf8');
construire('faq-bbp');
verifie('la régénération est idempotente (fichier identique)',
  fs.readFileSync(genere, 'utf8') === avant);

// ---------------------------------------------------------------------------
// 2. Chargeur : silencieux quand la marque n'a pas de FAQ
// ---------------------------------------------------------------------------

groupe('2. Chargeur par marque');

verifie('une marque sans FAQ renvoie null (pas d\'exception)', knowledge.loadKnowledge('misu') === null);
verifie('un slug inconnu renvoie null', knowledge.loadKnowledge('marque-inexistante') === null);
verifie('un slug vide renvoie null', knowledge.loadKnowledge('') === null && knowledge.loadKnowledge(undefined) === null);
verifie('la casse ne compte pas', knowledge.loadKnowledge('BBP') === k);

// ---------------------------------------------------------------------------
// 3. Rendu dans le prompt
// ---------------------------------------------------------------------------

groupe('3. Rendu du bloc de prompt');

verifie('sans base, le rendu est vide', knowledge.renderKnowledge(null) === '');

const bloc = knowledge.renderKnowledge(k);
verifie('les trois règles sont présentes',
  bloc.includes('REPRODUCTION MOT POUR MOT')
  && bloc.includes('AUCUN CHIFFRE INVENTÉ')
  && bloc.includes('TOUT CE QUI N\'EST PAS COUVERT PASSE PAR LUC'));
verifie('les 29 réponses sont présentes mot pour mot dans le bloc',
  k.entrees.every((e) => bloc.includes(e.reponse)));
verifie('les 12 faits de référence sont présents',
  k.faits.every((f) => bloc.includes(f.fait + ' : ' + f.valeur)));
verifie('la note sur l\'adresse de retour est présente', bloc.includes('adresse postale de retour'));
verifie('les quatre interdits sont présents', k.interdits.every((i) => bloc.includes(i)));

// ---------------------------------------------------------------------------
// 4. Injection dans le prompt système
// ---------------------------------------------------------------------------

groupe('4. Injection dans buildSystemPrompt');

function ctxFactice(extra = {}) {
  return {
    ticket: { channel: 'email', category: 'SAV', contact_name: 'Marion', contact_email: null, related_order_number: null },
    categories: [{ label: 'SAV' }, { label: 'Influence' }],
    settings: { signature_name: 'Alice', brand_name: 'Bons Baisers de Paname' },
    styleExamples: [],
    replyChannel: 'email',
    record: null,
    facts: { decision: null, awaitingReply: true, withinWindow: true, pendingHumanDraft: false, initiatedBy: 'contact' },
    ...extra,
  };
}

const promptAvecFaq = _internal.buildSystemPrompt(ctxFactice({ knowledge: k }));
verifie('le prompt contient le bloc de connaissance', promptAvecFaq.includes('BASE DE CONNAISSANCE DE LA MARQUE'));
verifie('le prompt contient une réponse officielle mot pour mot',
  promptAvecFaq.includes(k.entrees.find((e) => e.question.includes('conditions de retour')).reponse));
verifie('le bloc arrive avant les règles de la marque',
  promptAvecFaq.indexOf('BASE DE CONNAISSANCE DE LA MARQUE') < promptAvecFaq.indexOf('RÈGLES DE LA MARQUE'));

const promptSansFaq = _internal.buildSystemPrompt(ctxFactice({ knowledge: null }));
verifie('sans base, le prompt fonctionne comme avant', !promptSansFaq.includes('BASE DE CONNAISSANCE'));
verifie('sans base, les garde-fous stock restent en place', promptSansFaq.includes('ANNONCER UNE RUPTURE EST UN ACTE GRAVE'));

const promptCtxAncien = _internal.buildSystemPrompt(ctxFactice());
verifie('un contexte sans champ knowledge ne casse pas', typeof promptCtxAncien === 'string' && promptCtxAncien.length > 0);

// ---------------------------------------------------------------------------
// 5. Filet « aucun chiffre inventé »
// ---------------------------------------------------------------------------

groupe('5. montantsHorsReference');

const mhr = (t) => knowledge.montantsHorsReference(t, k);
verifie('5,90 € est un montant de référence', mhr('Nous retenons 5,90 € de frais de retour.').length === 0);
verifie('2,90 € et 4,90 € aussi', mhr('Mondial Relay 2,90 €, Colissimo 4,90 €.').length === 0);
verifie('offert dès 100 € aussi', mhr('La livraison est offerte dès 100 € d\'achat.').length === 0);
verifie('6,90 € est signalé', mhr('Nous retenons 6,90 € de frais de retour.').join() === '6,90');
verifie('« 79 euros » est signalé', mhr('Vous serez remboursée de 79 euros.').join() === '79');
verifie('un texte sans montant ne signale rien', mhr('Votre colis part demain.').length === 0);
verifie('sans base, aucun signalement', knowledge.montantsHorsReference('6,90 €', null).length === 0);

groupe('6. adressePostaleDansTexte');

const adr = knowledge.adressePostaleDansTexte;
verifie('une adresse est détectée', adr('Renvoyez à : 12 rue de Turbigo, 75003 Paris'));
verifie('une adresse sans virgule est détectée', adr('Showroom Turbigo 75003 Paris'));
verifie('un numéro de commande ne l\'est pas', adr('Votre commande #12345 est partie.') === false);
verifie('un code postal seul ne l\'est pas', adr('Code postal : 75003 ?') === false);
verifie('un texte ordinaire ne l\'est pas', adr('Votre étiquette prépayée est en pièce jointe.') === false);

// ---------------------------------------------------------------------------
// 7. applyGuardrails : les alertes sont posées, le brouillon n'est pas bloqué
// ---------------------------------------------------------------------------

groupe('7. applyGuardrails');

function garde(draft, extra = {}) {
  const ctx = ctxFactice({ knowledge: k, ...extra });
  return _internal.applyGuardrails(ctx, {
    category: 'SAV', summary: 'Question retour', sentiment: 'neutre', register: 'vouvoiement',
    gifting_stage: 'hors_gifting', brand_proposed_gifting: false, needs_decision: false,
    alerts: [], should_draft: true, draft_body: draft, draft_rationale: 'test',
  }, { mode: 'manual', instruction: null, toolCalls: [] });
}

const bon = garde('Bonjour Marion,\n\nNous retenons 5,90 € de frais de retour.\n\nBelle journée,\nAlice');
verifie('brouillon conforme : aucune alerte de chiffre', !bon.alerts.some((a) => a.detail && a.detail.includes('faits de référence')));
verifie('brouillon conforme : conservé', bon.should_draft === true && bon.draft_body.length > 0);

const faux = garde('Bonjour Marion,\n\nNous retenons 6,90 € de frais de retour.\n\nBelle journée,\nAlice');
verifie('montant inventé : alerte info_manquante posée',
  faux.alerts.some((a) => a.code === 'info_manquante' && a.detail.includes('6,90')),
  JSON.stringify(faux.alerts));
verifie('montant inventé : le brouillon N\'EST PAS bloqué (Luc relit)', faux.should_draft === true);

const avecAdresse = garde('Bonjour,\n\nRenvoyez le colis au 12 rue de Turbigo, 75003 Paris.\n\nAlice');
verifie('adresse postale : alerte sensible posée',
  avecAdresse.alerts.some((a) => a.code === 'sensible'),
  JSON.stringify(avecAdresse.alerts));

const sansBase = _internal.applyGuardrails(ctxFactice({ knowledge: null }), {
  category: 'SAV', summary: 's', sentiment: 'neutre', register: 'vouvoiement',
  gifting_stage: 'hors_gifting', brand_proposed_gifting: false, needs_decision: false,
  alerts: [], should_draft: true, draft_body: 'Nous retenons 6,90 € de frais.', draft_rationale: 't',
}, { mode: 'manual', instruction: null, toolCalls: [] });
verifie('marque sans FAQ : aucun filet, aucune alerte parasite',
  !sansBase.alerts.some((a) => a.code === 'info_manquante') && sansBase.should_draft === true);

// ---------------------------------------------------------------------------
// 8. Mise en cache du prompt système
// ---------------------------------------------------------------------------

groupe('8. Mise en cache du prompt (lib/ai/anthropic.js)');

const { _internal: anthropic } = require('../lib/ai/anthropic');
const court = anthropic.systemPayload('prompt court');
verifie('un prompt court reste une chaîne simple', typeof court === 'string' && court === 'prompt court');

const long = anthropic.systemPayload(promptAvecFaq);
verifie('un prompt long devient un bloc avec point de césure',
  Array.isArray(long) && long.length === 1
  && long[0].type === 'text'
  && long[0].cache_control.type === 'ephemeral');
verifie('le texte du prompt n\'est pas altéré par la mise en cache', long[0].text === promptAvecFaq);
verifie('le prompt avec FAQ dépasse largement le seuil de cache',
  promptAvecFaq.length > anthropic.MIN_CACHE_CHARS * 3,
  promptAvecFaq.length + ' caractères');
verifie('null / undefined ne cassent rien', anthropic.systemPayload(null) === '' && anthropic.systemPayload(undefined) === '');

// ---------------------------------------------------------------------------

console.log('\n' + (echecs === 0
  ? `Tous les tests passent (${reussites}).`
  : `${echecs} ÉCHEC(S) sur ${reussites + echecs} tests.`));
process.exit(echecs === 0 ? 0 : 1);
