#!/usr/bin/env node
// scripts/build-knowledge.js
// Ajout 2026-09-19, demandé par Luc : brancher la base de connaissance FAQ sur
// Alice. Ce script transforme la base de connaissance écrite en markdown
// (lib/ai/knowledge/<slug>.source.md) en module JavaScript lu par
// lib/ai/knowledge.js.
//
// Pourquoi un script de génération plutôt qu'un module écrit à la main :
// - le texte des réponses doit être MOT POUR MOT celui du markdown, seule
//   source de vérité relue par Luc ; le recopier à la main, c'est se donner
//   une occasion de le déformer ;
// - le module est écrit en JSON échappé (JSON.stringify), JAMAIS en gabarit de
//   chaîne : le document contient des accents graves, des « ${ } » possibles
//   et des blocs de code, qui casseraient un template literal.
//
// Usage :
//   node scripts/build-knowledge.js            # régénère toutes les sources
//   node scripts/build-knowledge.js bbp        # une seule marque
//
// Le module généré ne doit pas être édité à la main : modifier le .source.md
// puis relancer ce script.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'lib', 'ai', 'knowledge');

// --- petits utilitaires de découpage -----------------------------------------

function normalise(texte) {
  return String(texte).replace(/\r\n?/g, '\n');
}

/** Contenu d'une section « ## n. Titre » jusqu'à la section de même niveau suivante. */
function section(md, titre) {
  const re = new RegExp('^##\\s+' + titre + '\\s*$', 'm');
  const debut = md.match(re);
  if (!debut) return null;
  const apres = md.slice(debut.index + debut[0].length);
  const fin = apres.search(/^##\s+/m);
  return (fin === -1 ? apres : apres.slice(0, fin))
    // Les filets horizontaux « --- » séparent les sections dans le markdown :
    // ils n'ont rien à faire dans le texte extrait (ils se retrouvaient collés
    // à la fin de la note des faits de référence).
    .replace(/^-{3,}\s*$/gm, '')
    .trim();
}

/** Réunit les lignes d'un paragraphe replié sur plusieurs lignes. */
function replier(texte) {
  return texte.replace(/\s*\n\s*/g, ' ').trim();
}

function sansGras(texte) {
  return texte.replace(/\*\*/g, '');
}

// --- analyse des sections ----------------------------------------------------

function lireRegleOr(md) {
  const s = section(md, '1\\.\\s*Règle d.or');
  if (!s) throw new Error('section « Règle d\'or » introuvable');
  return sansGras(replier(s));
}

function lireInterdits(md) {
  const s = section(md, '2\\.\\s*Les quatre interdits');
  if (!s) throw new Error('section « Les quatre interdits » introuvable');
  const lignes = s.split('\n');
  const intro = [];
  const interdits = [];
  let courant = null;
  for (const ligne of lignes) {
    const debut = ligne.match(/^(\d+)\.\s+(.*)$/);
    if (debut) {
      if (courant) interdits.push(courant);
      courant = debut[2];
      continue;
    }
    if (courant === null) {
      if (ligne.trim()) intro.push(ligne.trim());
      continue;
    }
    courant += '\n' + ligne;
  }
  if (courant) interdits.push(courant);
  if (interdits.length !== 4) {
    throw new Error('4 interdits attendus, ' + interdits.length + ' trouvés');
  }
  return { intro: sansGras(intro.join(' ')), interdits: interdits.map((i) => sansGras(replier(i))) };
}

function lireHorsPerimetre(md) {
  const s = section(md, '3\\.\\s*Hors périmètre');
  if (!s) throw new Error('section « Hors périmètre » introuvable');
  return sansGras(replier(s));
}

function lireFaits(md) {
  const s = section(md, '4\\.\\s*Faits de référence');
  if (!s) throw new Error('section « Faits de référence » introuvable');
  const lignes = s.split('\n');
  const faits = [];
  const avant = [];
  const apres = [];
  let dansTable = false;
  let tableFinie = false;
  for (const ligne of lignes) {
    const cellules = ligne.match(/^\|(.+)\|\s*$/);
    if (cellules) {
      dansTable = true;
      const cols = cellules[1].split('|').map((c) => c.trim());
      // en-tête et ligne de séparation ignorées
      if (cols.length === 2 && !/^-+$/.test(cols[0]) && cols[0] !== 'Fait') {
        faits.push({ fait: cols[0], valeur: cols[1] });
      }
      continue;
    }
    if (dansTable && ligne.trim() === '') { tableFinie = true; continue; }
    if (!ligne.trim()) continue;
    (tableFinie ? apres : avant).push(ligne.trim());
  }
  if (!faits.length) throw new Error('tableau des faits de référence vide');
  return { consigne: sansGras(avant.join(' ')), faits, note: sansGras(apres.join(' ')) };
}

const MODES = {
  '✅': 'auto',
  '⚠️': 'conditionnel',
  '❌': 'jamais',
};

function lireReponses(md) {
  const s = section(md, '5\\.\\s*Les réponses');
  if (!s) throw new Error('section « Les réponses » introuvable');

  // Intro (avant le premier « ### »)
  const premiere = s.search(/^###\s+/m);
  const intro = sansGras(replier(premiere === -1 ? s : s.slice(0, premiere)));

  const entrees = [];
  const morceaux = s.split(/^###\s+/m).slice(1);
  for (const morceau of morceaux) {
    const sautLigne = morceau.indexOf('\n');
    const rubrique = morceau.slice(0, sautLigne === -1 ? undefined : sautLigne).trim();
    const corps = sautLigne === -1 ? '' : morceau.slice(sautLigne);
    for (const bloc of corps.split(/^####\s+/m).slice(1)) {
      const finQuestion = bloc.indexOf('\n');
      const question = bloc.slice(0, finQuestion === -1 ? undefined : finQuestion).trim();
      const reste = finQuestion === -1 ? '' : bloc.slice(finQuestion);

      const envoi = reste.match(/\*\*Envoi\s*:\s*(✅|⚠️|❌)[^*]*\*\*(\s*—\s*([^\n]+))?/);
      if (!envoi) throw new Error('ligne « Envoi : » introuvable pour « ' + question + ' »');
      const mode = MODES[envoi[1]];
      if (!mode) throw new Error('marqueur d\'envoi inconnu pour « ' + question + ' »');
      const note = envoi[3] ? envoi[3].trim() : null;

      const code = reste.match(/```\n([\s\S]*?)\n```/);
      if (!code) throw new Error('réponse (bloc de code) introuvable pour « ' + question + ' »');
      const reponse = code[1];

      const variables = [...new Set((reponse.match(/\{[a-z_]+\}/g) || []))];

      entrees.push({ rubrique, question, envoi: mode, note, reponse, variables });
    }
  }
  if (!entrees.length) throw new Error('aucune réponse trouvée');
  return { intro, entrees };
}

// --- génération --------------------------------------------------------------

function construire(slug) {
  const source = path.join(DIR, slug + '.source.md');
  const md = normalise(fs.readFileSync(source, 'utf8'));

  const titre = (md.match(/^#\s+(.+)$/m) || [, ''])[1].trim();
  const version = (md.match(/Version du\s+([0-9/]+)/) || [, null])[1];

  const interdits = lireInterdits(md);
  const faits = lireFaits(md);
  const reponses = lireReponses(md);

  const data = {
    nom: slug,
    titre,
    version,
    source: 'lib/ai/knowledge/' + slug + '.source.md',
    regle_or: lireRegleOr(md),
    interdits_intro: interdits.intro,
    interdits: interdits.interdits,
    hors_perimetre: lireHorsPerimetre(md),
    faits_consigne: faits.consigne,
    faits: faits.faits,
    faits_note: faits.note,
    reponses_intro: reponses.intro,
    entrees: reponses.entrees,
  };

  // Montants cités par les faits de référence : ils servent de filet côté
  // code (voir lib/ai/knowledge.js, montantsHorsReference).
  data.montants_autorises = [...new Set(
    faits.faits
      .map((f) => f.valeur.match(/\d+(?:[,.]\d+)?\s*€/g) || [])
      .flat()
      .map((m) => m.replace(/\s*€/, '').replace('.', ','))
  )].sort();

  const cible = path.join(DIR, slug + '.js');
  const entete = [
    '// ' + data.source.replace('.source.md', '.js'),
    '// FICHIER GÉNÉRÉ — ne pas éditer à la main.',
    '// Source : ' + data.source,
    '// Générateur : scripts/build-knowledge.js',
    '// Le contenu est en JSON échappé (jamais un gabarit de chaîne) : le',
    '// document contient des accents graves et des accolades, qui casseraient',
    '// un template literal.',
    '',
    'module.exports = ' + JSON.stringify(data, null, 2) + ';',
    '',
  ].join('\n');

  fs.writeFileSync(cible, entete, 'utf8');
  return { slug, cible, entrees: data.entrees.length, faits: data.faits.length };
}

function main() {
  const demandes = process.argv.slice(2);
  const slugs = demandes.length
    ? demandes
    : fs.readdirSync(DIR).filter((f) => f.endsWith('.source.md')).map((f) => f.replace(/\.source\.md$/, ''));
  if (!slugs.length) {
    console.error('Aucune source trouvée dans ' + DIR);
    process.exit(1);
  }
  for (const slug of slugs) {
    const r = construire(slug);
    console.log(`${r.slug} → ${path.relative(process.cwd(), r.cible)} (${r.entrees} réponses, ${r.faits} faits de référence)`);
  }
}

if (require.main === module) main();

module.exports = { construire };
