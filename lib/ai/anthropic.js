// lib/ai/anthropic.js
// Ajout 2026-09-16 (brouillons IA) : client minimal de l'API Claude
// (Anthropic Messages API), sans dépendance npm — un simple fetch.
//
// La clé est lue dans la variable d'environnement ANTHROPIC_API_KEY (posée
// sur Vercel, marquée "Sensitive"). Elle n'est JAMAIS écrite en base, dans
// le code ni dans les logs. Le modèle est réglable sans toucher au code via
// ANTHROPIC_MODEL (par défaut claude-sonnet-5, bon équilibre qualité/coût).
//
// runToolLoop() fait dialoguer Claude avec des "outils" : Claude peut
// d'abord appeler un outil de consultation (ex. vérifier le stock), on lui
// renvoie le résultat, puis il DOIT terminer en appelant l'outil final
// (ex. enregistrer_analyse) dont on récupère l'entrée structurée — c'est ce
// qui garantit une réponse au format attendu, jamais du texte libre à parser.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function getModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Correctif 2026-09-17 : un texte coupé à N caractères (.slice) peut couper
// un emoji en deux (un emoji = 2 « demi-caractères » en JavaScript). Le demi-
// caractère orphelin rend le JSON refusé par l'API Claude (« no low surrogate
// in string »). On retire ces orphelins partout dans la requête avant l'envoi.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function toWellFormed(value) {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '');
  if (Array.isArray(value)) return value.map(toWellFormed);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWellFormed(v);
    return out;
  }
  return value;
}

async function createMessage(payload, { timeoutMs = 45000, retries = 2 } = {}) {
  if (!isConfigured()) {
    const err = new Error('ai_not_configured');
    err.code = 'ai_not_configured';
    throw err;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(toWellFormed(payload)),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;

      const err = new Error(data?.error?.message || `anthropic_http_${response.status}`);
      err.code = 'ai_api_error';
      err.status = response.status;
      err.type = data?.error?.type;
      // 429 (limite de débit), 529 (surcharge) et 5xx : on retente après une
      // courte pause. Les autres erreurs (clé invalide, requête mal formée,
      // crédit épuisé...) ne servent à rien d'être retentées.
      if ([429, 500, 502, 503, 504, 529].includes(response.status) && attempt < retries) {
        lastErr = err;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('ai_timeout');
        timeoutErr.code = 'ai_timeout';
        if (attempt < retries) { lastErr = timeoutErr; continue; }
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Boucle d'outils.
 * - tools : définitions d'outils Anthropic ({name, description, input_schema}).
 * - finalToolName : l'outil dont l'entrée constitue le résultat final.
 * - toolHandlers : { [nomOutil]: async (input) => résultat JSON-sérialisable }.
 * Retourne { result, usage, turns, toolCalls }.
 */
/**
 * Ajout 2026-09-19 : mise en cache du prompt système.
 *
 * Pourquoi maintenant : la base de connaissance FAQ ajoute ~5 000 jetons au
 * prompt système, et ce prompt est RENVOYÉ EN ENTIER à chaque tour de la
 * boucle d'outils (jusqu'à 8 tours en mode enquête). Sans cache, une seule
 * analyse pouvait payer 40 000 jetons d'entrée pour un texte identique d'un
 * tour à l'autre.
 *
 * Le point de césure posé sur le bloc système couvre aussi les définitions
 * d'outils, qui le précèdent dans l'ordre du cache. Sous le seuil de mise en
 * cache de l'API (1 024 jetons, soit ~3 500 caractères), on envoie la chaîne
 * telle quelle : la forme en blocs n'apporterait rien.
 */
const MIN_CACHE_CHARS = 4000;

function systemPayload(system) {
  const texte = typeof system === 'string' ? system : String(system || '');
  if (texte.length < MIN_CACHE_CHARS) return texte;
  return [{ type: 'text', text: texte, cache_control: { type: 'ephemeral' } }];
}

async function runToolLoop({ system, messages, tools, finalToolName, toolHandlers = {}, maxTurns = 4, maxTokens = 2000 }) {
  const convo = messages.slice();
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const toolCalls = [];
  const systemBlocks = systemPayload(system);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const isLastTurn = turn === maxTurns;
    const data = await createMessage({
      model: getModel(),
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: convo,
      tools,
      // Au dernier tour, on impose l'outil final pour garantir un résultat.
      tool_choice: isLastTurn ? { type: 'tool', name: finalToolName } : { type: 'any' },
    });
    // Les jetons mis en cache sont comptés à part par l'API : on les additionne
    // dans input_tokens pour que le volume affiché reste comparable à avant, et
    // on garde le détail pour mesurer ce que le cache fait vraiment économiser
    // (un jeton relu au cache coûte 10 % d'un jeton d'entrée).
    const u = data?.usage || {};
    const cacheCreation = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    usage.input_tokens += (u.input_tokens || 0) + cacheCreation + cacheRead;
    usage.output_tokens += u.output_tokens || 0;
    usage.cache_creation_input_tokens += cacheCreation;
    usage.cache_read_input_tokens += cacheRead;

    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    const final = toolUses.find((b) => b.name === finalToolName);
    if (final) {
      return { result: final.input || {}, usage, turns: turn, toolCalls, model: data.model || getModel() };
    }
    if (toolUses.length === 0) {
      // Ne devrait pas arriver avec tool_choice any/tool — on force au tour suivant.
      convo.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
      convo.push({ role: 'user', content: `Termine maintenant en appelant l'outil ${finalToolName}.` });
      continue;
    }

    convo.push({ role: 'assistant', content: blocks });
    // Correctif 2026-09-17 (enquête) : les outils demandés dans un même tour
    // sont exécutés en parallèle (recherches Shopify / e-mails / tickets).
    const outputs = await Promise.all(toolUses.map(async (use) => {
      const handler = toolHandlers[use.name];
      try {
        return handler ? await handler(use.input || {}) : { error: 'outil_inconnu' };
      } catch (err) {
        return { error: err.message || 'outil_en_erreur' };
      }
    }));
    const results = toolUses.map((use, i) => {
      toolCalls.push({ name: use.name, input: use.input, output: outputs[i] });
      return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(outputs[i] === undefined ? null : outputs[i]).slice(0, 12000) };
    });
    convo.push({ role: 'user', content: results });
  }
  const err = new Error('ai_no_final_result');
  err.code = 'ai_no_final_result';
  throw err;
}

module.exports = { createMessage, runToolLoop, isConfigured, getModel, _internal: { systemPayload, MIN_CACHE_CHARS } };
