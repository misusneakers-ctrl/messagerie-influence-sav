// api/uploads/attachment.js
// POST — reçoit un fichier (image, vidéo ou PDF — ex. étiquette de transport)
// encodé en base64, le dépose sur Vercel Blob storage et renvoie son URL
// publique. Correctif 2026-09-15 : jusqu'ici il n'existait aucun moyen de
// joindre un fichier à un message SORTANT (seuls les messages Instagram
// ENTRANTS pouvaient avoir des pièces jointes, via le sondage Instagram).
//
// Nécessite le stockage Vercel Blob activé sur ce projet Vercel (onglet
// "Storage" du dashboard Vercel → créer un Blob store → le connecter au
// projet messagerie-influence-sav) : Vercel pose alors automatiquement la
// variable d'environnement BLOB_READ_WRITE_TOKEN, utilisée ici implicitement
// par le SDK @vercel/blob — rien à configurer à la main côté code.
//
// Le fichier arrive en JSON (base64), pas en multipart : plus simple à
// implémenter côté fonction serverless sans dépendance supplémentaire, au
// prix d'un gonflement d'environ 33% de la taille — d'où la limite à 4 Mo
// ci-dessous, confortablement sous la limite de payload JSON par défaut de
// Vercel (4,5 Mo), largement suffisant pour une image ou une étiquette PDF.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { put } = require('@vercel/blob');

const MAX_BYTES = 4 * 1024 * 1024; // 4 Mo

// Types acceptés pour une pièce jointe SORTANT, mappés vers le même format
// {type: 'image'|'video'|'file'} déjà utilisé pour les pièces jointes
// entrantes Instagram (voir lib/channels/instagram-read.js).
const ALLOWED_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'application/pdf': 'file',
};

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const body = req.body || {};
  if (!body.filename || !body.content_base64 || !body.content_type) {
    sendJson(res, 400, { error: 'filename_content_base64_content_type_required' });
    return;
  }

  const kind = ALLOWED_TYPES[body.content_type];
  if (!kind) {
    sendJson(res, 400, { error: 'unsupported_content_type', allowed: Object.keys(ALLOWED_TYPES) });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(body.content_base64, 'base64');
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_base64' });
    return;
  }
  if (buffer.length === 0) {
    sendJson(res, 400, { error: 'empty_file' });
    return;
  }
  if (buffer.length > MAX_BYTES) {
    sendJson(res, 413, { error: 'file_too_large', max_bytes: MAX_BYTES });
    return;
  }

  // Nom de fichier assaini + horodatage pour éviter toute collision entre
  // deux fichiers du même nom, et préfixé par le tenant pour garder les
  // fichiers des deux marques bien séparés dans le stockage (même logique
  // d'isolation que tenant_id en base, même si Blob storage n'a pas de
  // notion de tenant natif).
  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  const path = `attachments/${tenant.slug}/${Date.now()}-${safeName}`;

  try {
    const blob = await put(path, buffer, {
      access: 'public',
      contentType: body.content_type,
    });
    sendJson(res, 201, { url: blob.url, type: kind, filename: body.filename });
  } catch (err) {
    sendJson(res, 502, { error: 'upload_failed', detail: err.message });
  }
});
