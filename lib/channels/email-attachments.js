// lib/channels/email-attachments.js
// Ajout 2026-09-18, demandé par Luc : « il faut que je puisse voir toutes les
// pièces jointes de tous les canaux, je ne reçois pas pour Gmail ».
//
// Jusqu'ici, un e-mail importé ne gardait que le NOM de ses pièces jointes,
// ajouté en bas du texte (« [pièce(s) jointe(s) : photo.jpg] ») : rien à
// ouvrir, rien à regarder. Les photos d'un produit défectueux, par exemple,
// restaient invisibles dans la messagerie — et invisibles pour Alice.
//
// Ici, on télécharge le contenu réel depuis Gmail (lecture seule) et on le
// dépose sur Vercel Blob, exactement comme une pièce jointe sortante
// (api/uploads/attachment.js). Le message porte alors le même format
// d'attachments que les messages Instagram :
//   [{ type: 'image'|'video'|'file', url, filename, mime_type, size }]
// et l'interface les affiche sans rien changer (voir renderThread).
const { put } = require('@vercel/blob');
const { gmailFetch } = require('../gmail/client');

const MAX_BYTES_PER_FILE = 10 * 1024 * 1024; // 10 Mo — au-delà, on garde le nom seulement
const MAX_FILES_PER_MESSAGE = 10;
// Une image « inline » minuscule est presque toujours un logo de signature ou
// un pixel de suivi : on ne l'affiche pas dans le fil.
const MIN_INLINE_IMAGE_BYTES = 20 * 1024;

function kindOf(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

function safeName(filename) {
  return String(filename || 'piece-jointe').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

function worthKeeping(att) {
  if (!att.attachment_id) return false;
  const size = Number(att.size || 0);
  if (size > MAX_BYTES_PER_FILE) return false;
  if (att.inline && kindOf(att.mime_type) === 'image' && size > 0 && size < MIN_INLINE_IMAGE_BYTES) return false;
  return true;
}

/**
 * Télécharge les pièces jointes d'un e-mail et les dépose sur Blob.
 * @param {string} accessToken jeton Gmail (lecture seule)
 * @param {string} tenantSlug  marque, pour ranger les fichiers séparément
 * @param {object} msg         message parsé (id + attachments)
 * @param {object} opts        { deadline } horodatage au-delà duquel on arrête
 * @returns {Promise<{attachments: Array, skipped: Array}>}
 */
async function fetchEmailAttachments(accessToken, tenantSlug, msg, opts = {}) {
  const deadline = opts.deadline || Infinity;
  const attachments = [];
  const skipped = [];
  const list = (msg.attachments || []).slice(0, MAX_FILES_PER_MESSAGE);

  for (const att of list) {
    if (!worthKeeping(att)) {
      if (att.attachment_id && Number(att.size || 0) > MAX_BYTES_PER_FILE) {
        skipped.push({ filename: att.filename, reason: 'trop_volumineuse' });
      }
      continue;
    }
    if (Date.now() > deadline) {
      skipped.push({ filename: att.filename, reason: 'temps_ecoule' });
      continue;
    }
    try {
      const data = await gmailFetch(accessToken, `/messages/${msg.id}/attachments/${att.attachment_id}`);
      const buffer = Buffer.from(String(data.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (!buffer.length) {
        skipped.push({ filename: att.filename, reason: 'vide' });
        continue;
      }
      if (buffer.length > MAX_BYTES_PER_FILE) {
        skipped.push({ filename: att.filename, reason: 'trop_volumineuse' });
        continue;
      }
      const blob = await put(
        `attachments/${tenantSlug}/email/${msg.id}-${safeName(att.filename)}`,
        buffer,
        { access: 'public', contentType: att.mime_type || 'application/octet-stream', addRandomSuffix: true }
      );
      attachments.push({
        type: kindOf(att.mime_type),
        url: blob.url,
        filename: att.filename || 'piece-jointe',
        mime_type: att.mime_type || null,
        size: buffer.length,
      });
    } catch (err) {
      skipped.push({ filename: att.filename, reason: err.message });
    }
  }
  return { attachments, skipped };
}

/** Note de bas de message pour ce qui n'a pas pu être téléchargé. */
function skippedNote(skipped) {
  if (!skipped || !skipped.length) return '';
  const trop = skipped.filter((s) => s.reason === 'trop_volumineuse').map((s) => s.filename);
  const autres = skipped.filter((s) => s.reason !== 'trop_volumineuse').map((s) => s.filename);
  const parts = [];
  if (trop.length) parts.push(`trop volumineuse(s), à ouvrir dans Gmail : ${trop.join(', ')}`);
  if (autres.length) parts.push(`non récupérée(s) : ${autres.join(', ')}`);
  return parts.length ? `\n[pièce(s) jointe(s) ${parts.join(' ; ')}]` : '';
}

module.exports = { fetchEmailAttachments, skippedNote, MAX_BYTES_PER_FILE, MIN_INLINE_IMAGE_BYTES };
