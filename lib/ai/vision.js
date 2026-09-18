// lib/ai/vision.js
// Ajout 2026-09-18, demandé par Luc : « Alice doit être capable de lire les
// pièces jointes. Par exemple, si une influenceuse attache un screenshot du
// produit qu'elle a choisi, il faut qu'elle soit capable de repérer le produit
// et de lui commander. »
//
// Jusqu'ici, une photo n'arrivait à Claude que sous la forme « [pièce jointe :
// image] » dans le fil : Alice savait qu'il y avait une image, sans pouvoir la
// regarder. Elle demandait donc à la personne de répéter le modèle qu'elle
// venait pourtant d'envoyer.
//
// Ici, on télécharge les images de la conversation et on les joint au message
// envoyé à Claude, au format « image » de l'API Anthropic. Alice peut alors
// identifier le modèle et le coloris — puis, comme pour tout fait, le
// CONFIRMER avec verifier_stock avant d'affirmer quoi que ce soit (voir la
// section PHOTOS du prompt système). Rien n'est commandé automatiquement : la
// commande gifting reste « Alice prépare, Luc clique ».
//
// Sources possibles d'une image : Vercel Blob (pièces jointes e-mail et
// sortantes) ou le CDN Instagram (liens signés, qui expirent). Une image
// illisible est simplement signalée, jamais bloquante.

const MAX_BYTES = 3.5 * 1024 * 1024;     // par image (limite API ≈ 5 Mo en base64)
const MAX_TOTAL_BYTES = 9 * 1024 * 1024; // pour une même requête
const FETCH_TIMEOUT_MS = 8000;

// Formats acceptés par l'API Anthropic.
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function mediaTypeOf(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (SUPPORTED.includes(ct)) return ct;
  if (ct === 'image/jpg') return 'image/jpeg';
  // Un type d'image explicite mais non géré (bmp, heic, tiff…) est refusé :
  // on ne se rabat sur l'extension que si le serveur n'annonce rien d'utile
  // (cas fréquent des CDN qui renvoient application/octet-stream).
  if (ct.startsWith('image/')) return null;
  const ext = String(url || '').toLowerCase().split('?')[0].split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return null;
}

/** Pièces jointes image de la conversation, de la plus ancienne à la plus récente. */
function listImageAttachments(messages) {
  const out = [];
  for (const m of messages || []) {
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    for (const a of atts) {
      if (!a || !a.url) continue;
      const isImage = a.type === 'image'
        || String(a.mime_type || '').toLowerCase().startsWith('image/');
      if (!isImage) continue;
      out.push({
        url: a.url,
        filename: a.filename || null,
        mime_type: a.mime_type || null,
        direction: m.direction,
        at: m.sent_at || m.created_at,
      });
    }
  }
  return out;
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { error: `http_${resp.status}` };
    const mediaType = mediaTypeOf(resp.headers.get('content-type'), url);
    if (!mediaType) return { error: 'format_non_supporte' };
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) return { error: 'trop_volumineuse' };
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!buffer.length) return { error: 'vide' };
    if (buffer.length > MAX_BYTES) return { error: 'trop_volumineuse' };
    return { mediaType, buffer };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'delai_depasse' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Blocs « image » à joindre au message utilisateur, pour les `max` dernières
 * photos de la conversation.
 * @returns {Promise<{blocks: Array, used: number, skipped: Array}>}
 */
async function buildImageBlocks(messages, { max = 4, formatDate = (d) => String(d) } = {}) {
  const all = listImageAttachments(messages);
  if (!all.length) return { blocks: [], used: 0, skipped: [] };

  // Les plus récentes d'abord pour le choix, puis remises dans l'ordre du fil.
  const picked = all.slice(-max);
  const blocks = [];
  const skipped = [];
  let total = 0;

  for (const att of picked) {
    if (total >= MAX_TOTAL_BYTES) { skipped.push({ filename: att.filename, reason: 'lot_trop_lourd' }); continue; }
    const res = await fetchImage(att.url);
    if (res.error) { skipped.push({ filename: att.filename, reason: res.error }); continue; }
    total += res.buffer.length;
    const qui = att.direction === 'inbound' ? 'le contact' : 'la marque';
    blocks.push({
      type: 'text',
      text: `Photo jointe par ${qui} le ${formatDate(att.at)}${att.filename ? ` (${att.filename})` : ''} :`,
    });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: res.mediaType, data: res.buffer.toString('base64') },
    });
  }

  if (skipped.length) {
    blocks.push({
      type: 'text',
      text: `(${skipped.length} pièce(s) jointe(s) image non lisible(s) : ${skipped.map((s) => s.reason).join(', ')}. `
        + `Ne fais aucune hypothèse sur leur contenu ; demande à la personne si besoin.)`,
    });
  }

  return { blocks, used: blocks.filter((b) => b.type === 'image').length, skipped };
}

module.exports = { buildImageBlocks, listImageAttachments, MAX_BYTES };
