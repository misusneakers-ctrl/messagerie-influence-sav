// lib/text/clean.js
// Ajout 2026-09-18, demandé par Luc : dans la file de validation, « les
// messages sont en clair, c'est très étrange… que ce soit mieux résumé ».
//
// Ce qu'il voyait sur les cartes, tel quel :
//   « Bonjour, Dans cette attente, je vous remercie. Cordialement Y HUILLIER
//     Envoyé depuis l'application Mail Orange ---------------- »
//   « Je dÃ©sirerai annuler ma commande svp je me suis trompÃ©e. »
//   « Vous avez reçu un nouveau message du formulaire de contact de votre
//     boutique en ligne. Indicatif de pays: FR Nom: … Commentaire: … »
//
// Trois défauts distincts, traités ici une fois pour toutes :
// 1. des accents cassés (texte UTF-8 étiqueté iso-8859-1 par le client mail
//    de l'expéditeur — Outlook Android en particulier) ;
// 2. des signatures et bandeaux d'application qui occupent toute la place ;
// 3. le formulaire de contact Shopify, dont le vrai message est noyé dans
//    un gabarit de dix lignes.
//
// Volontairement conservateur : en cas de doute, on rend le texte d'origine.
// Un extrait tronqué à tort vaut mieux qu'un message déformé.

// Caractères que windows-1252 place là où latin-1 met des codes de contrôle.
// Selon le client mail, « ’ » cassé arrive en « â€™ » (windows-1252) ou en
// « â\u0080\u0099 » (latin-1) : on sait relire les deux.
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const SUITE = '[\\u0080-\\u00bf\\u20ac\\u201a\\u0192\\u201e\\u2026\\u2020\\u2021\\u02c6\\u2030'
  + '\\u0160\\u2039\\u0152\\u017d\\u2018\\u2019\\u201c\\u201d\\u2022\\u2013\\u2014\\u02dc'
  + '\\u2122\\u0161\\u203a\\u0153\\u017e\\u0178]';
// Amorces d'une séquence UTF-8 relue octet par octet : Ã (lettres accentuées),
// Â (symboles), â (ponctuation typographique).
const SEQUENCE = new RegExp('[\\u00c2\\u00c3\\u00e2]' + SUITE + '{1,2}', 'g');

function versOctet(caractere) {
  const code = caractere.codePointAt(0);
  if (code <= 0xff) return code;
  return CP1252[code] !== undefined ? CP1252[code] : null;
}

/**
 * Répare les accents d'un texte UTF-8 relu en latin-1 (« dÃ©sirerai » →
 * « désirerai »).
 *
 * Réparation séquence par séquence, et non sur le message entier : un
 * message peut mélanger du texte sain et quelques séquences cassées, et
 * relire le tout en latin-1 abîmerait le reste. Chaque séquence n'est
 * remplacée que si elle se relit en UTF-8 valide.
 * @param {string} text
 * @returns {string}
 */
function repairMojibake(text) {
  const s = String(text || '');
  if (!SEQUENCE.test(s)) { SEQUENCE.lastIndex = 0; return s; }
  SEQUENCE.lastIndex = 0;
  return s.replace(SEQUENCE, (sequence) => {
    const octets = [];
    for (const caractere of sequence) {
      const octet = versOctet(caractere);
      if (octet === null) return sequence;
      octets.push(octet);
    }
    const relu = Buffer.from(octets).toString('utf8');
    // Le caractère de remplacement signale une séquence qui n'en était pas
    // une : on laisse le texte d'origine intact.
    return relu.includes('�') ? sequence : relu;
  });
}

// Lignes à partir desquelles il n'y a plus rien d'utile à lire.
const FIN_DE_MESSAGE = [
  /^\s*--\s*$/,
  /^\s*_{4,}\s*$/,
  /^\s*-{4,}\s*$/,
  /^\s*envoyé\s+(depuis|de|à partir d)/i,
  /^\s*(sent|get outlook)\s+from/i,
  /^\s*obtenez\s+outlook\s+pour/i,
  /^\s*télécharger\s+outlook\s+pour/i,
];

// Formules de politesse : on les coupe seulement si elles terminent le
// message (une phrase utile peut commencer par « Cordialement, je… »).
const POLITESSE = /^\s*(bien\s+)?(cordialement|sincèrement|respectueusement|bonne\s+(journée|soirée|réception)|belle\s+journée|merci\s+d'avance|dans\s+l'attente)\b[\s,.!]*$/i;

/**
 * Retire la signature, le bandeau d'application et la formule de politesse
 * finale. L'historique cité (« Le … a écrit : », « > ») est déjà retiré à
 * la lecture Gmail (lib/gmail/client.js) ; on le refait ici par sécurité,
 * car cette fonction sert aussi à afficher d'anciens messages.
 * @param {string} text
 * @returns {string}
 */
function stripSignature(text) {
  const lignes = String(text || '').replace(/\r/g, '').split('\n');
  const gardees = [];
  for (const ligne of lignes) {
    if (/^\s*>/.test(ligne)) continue;
    if (/^\s*(Le|On) .{5,160}(a écrit|wrote)\s*:\s*$/i.test(ligne)) break;
    if (FIN_DE_MESSAGE.some((re) => re.test(ligne))) break;
    gardees.push(ligne);
  }
  // Politesse en fin de message uniquement.
  while (gardees.length && (POLITESSE.test(gardees[gardees.length - 1]) || !gardees[gardees.length - 1].trim())) {
    gardees.pop();
  }
  return gardees.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Message réel d'un envoi du formulaire de contact Shopify. Le gabarit met
 * le pays, le nom, l'e-mail et le téléphone avant le texte ; seul le
 * « Commentaire » intéresse Luc. Renvoie aussi le nom et l'e-mail annoncés,
 * qui valent mieux que « Bons baisers de Paname FR (Shopify) ».
 * @param {string} text
 * @returns {{body: string, name: string|null, email: string|null}|null}
 */
function parseContactForm(text) {
  const s = String(text || '');
  if (!/formulaire de contact|contact form/i.test(s)) return null;
  const champ = (label) => {
    const m = s.match(new RegExp(label + '\\s*:?\\s*\\n+\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : null;
  };
  const m = s.match(/(?:Commentaire|Message|Comment)\s*:?\s*\n+([\s\S]*)$/i);
  const body = m ? m[1].trim() : null;
  if (!body) return null;
  const email = champ('E-?mail');
  return {
    body,
    name: champ('Nom') || null,
    email: email && /@/.test(email) ? email.toLowerCase() : null,
  };
}

/**
 * Texte lisible d'un message reçu : accents réparés, signature retirée,
 * formulaire de contact déplié.
 * @param {string} text
 * @returns {string}
 */
function cleanIncoming(text) {
  const repare = repairMojibake(text);
  const form = parseContactForm(repare);
  const utile = form ? form.body : repare;
  const propre = stripSignature(utile);
  return (propre || repare || '')
    // « <https://aka.ms/AAb9ysg> » : garder le lien sans les chevrons.
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .trim();
}

/**
 * Extrait sur une ou deux lignes, pour une carte de liste.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function excerpt(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const coupe = s.slice(0, max);
  const espace = coupe.lastIndexOf(' ');
  return (espace > max * 0.6 ? coupe.slice(0, espace) : coupe).trim() + '…';
}

module.exports = { repairMojibake, stripSignature, parseContactForm, cleanIncoming, excerpt };
