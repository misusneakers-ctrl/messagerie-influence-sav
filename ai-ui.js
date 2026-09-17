// ai-ui.js — interface des brouillons IA (ajout 2026-09-16)
// Chargé par index.html juste après son script principal. Volontairement dans
// un fichier séparé : index.html fait plus de 100 Ko et n'a besoin que d'une
// ligne (<script src="/ai-ui.js"></script>) — toute l'interface IA vit ici.
//
// Ce fichier réutilise les fonctions globales d'index.html (state, api,
// toast, escapeHtml, fmtDate, refreshSelectedTicket, loadTickets, loadQueue)
// et « enveloppe » quatre d'entre elles pour ajouter l'IA sans les réécrire :
// - syncInstagram     : après l'actualisation, lance l'analyse IA des
//                       nouveaux messages (brouillons Influence) ;
// - renderDetail      : ajoute le panneau « ✨ Assistante IA » dans un ticket
//                       (résumé, alertes, recommandation, Accepter/Refuser,
//                       consigne + bouton « Préparer une réponse », et
//                       depuis le 16/09 la commande gifting Shopify à 0 €) ;
// - renderThread      : marque les brouillons rédigés par l'IA ;
// - renderQueue       : affiche alertes, justification et coordonnées d'envoi
//                       dans la file de validation.
// L'IA ne fait jamais d'envoi : tout brouillon passe par la validation de Luc.
(function () {
  'use strict';

  // ---------- Libellés ----------
  const AI_ALERTS = {
    decision_requise: { text: '⚖️ Décision requise', bad: true },
    client_mecontent: { text: '😟 Client mécontent — à relire', bad: true },
    demande_remuneration: { text: '💶 Rémunération / code demandé — à décider', bad: true },
    stock_indisponible: { text: '❌ Stock indisponible', bad: true },
    stock_a_verifier: { text: 'Stock à vérifier', bad: false },
    quota_a_verifier: { text: 'Quota gifting à vérifier', bad: false },
    envoi_a_preparer: { text: '📦 Envoi à préparer', bad: false },
    info_manquante: { text: 'Info manquante', bad: false },
    hors_fenetre_24h: { text: 'Hors fenêtre 24h', bad: true },
    sensible: { text: '⚠️ Sujet sensible', bad: true },
    autre: { text: 'À noter', bad: false },
  };
  const STAGES = {
    hors_gifting: 'hors gifting',
    demande_spontanee: 'demande spontanée',
    proposition_marque: 'proposition de la marque',
    choix_modele: 'choix du modèle',
    coordonnees_demandees: 'coordonnées demandées',
    coordonnees_recues: 'coordonnées reçues',
    envoi_confirme: 'envoi confirmé',
    suivi_contenu: 'suivi du contenu',
    refus: 'refus',
  };
  const SENTIMENTS = { positif: '😊 positif', neutre: '😐 neutre', inquiet: '😟 inquiet', mecontent: '😠 mécontent', agressif: '🔥 agressif' };
  const VERDICTS = { accepter: '👍 accepter', refuser: '👎 refuser', a_etudier: '🤔 à étudier' };

  function aiAlertBadge(a) {
    const def = AI_ALERTS[a.code] || { text: a.code, bad: false };
    const text = a.code === 'autre' && a.detail ? '📝 ' + a.detail : def.text;
    return `<span class="badge badge-alert${def.bad ? ' bad' : ''}" title="${escapeHtml(a.detail || '')}">${escapeHtml(text)}</span>`;
  }

  function shippingText(sd) {
    if (!sd) return '';
    return [sd.full_name, sd.address, [sd.postal_code, sd.city].filter(Boolean).join(' '), sd.country, sd.phone, sd.email]
      .filter((x) => x && String(x).trim()).join('\n');
  }

  function askName(label) {
    let last = 'Luc';
    try { last = localStorage.getItem('msav_ai_name') || 'Luc'; } catch (e) {}
    const name = window.prompt(label, last);
    if (name) { try { localStorage.setItem('msav_ai_name', name); } catch (e) {} }
    return name;
  }

  function aiErrorMessage(err) {
    const code = err && (err.payload && err.payload.error) || (err && err.message);
    if (code === 'ai_not_configured') return "L'IA n'est pas encore branchée : la variable ANTHROPIC_API_KEY est absente sur Vercel.";
    if (code === 'ai_timeout') return "L'IA a mis trop de temps à répondre — réessaie dans un instant.";
    if (code === 'ai_api_error') return 'Erreur de l\'API Claude : ' + ((err.payload && err.payload.message) || 'réessaie plus tard') + '.';
    return 'Erreur IA : ' + (code || 'inconnue');
  }

  // ---------- Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    .ai-box{margin-top:10px;padding:8px 12px;border:1px solid #e9d5ff;background:#faf5ff;border-radius:8px;font-size:12.5px;display:flex;flex-direction:column;gap:6px;}
    .ai-box .ai-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
    .ai-box .ai-head strong{font-size:13px;color:#6b21a8;}
    .ai-box .ai-muted{color:var(--muted);font-size:11.5px;}
    .ai-box .ai-summary{color:var(--text);}
    .ai-box .ai-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
    .ai-box .ai-row input[type="text"]{flex:1;min-width:180px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;}
    .ai-box .ai-decision{background:#fff;border:1px solid #f5d0fe;border-radius:8px;padding:6px 10px;display:flex;flex-direction:column;gap:5px;}
    .ai-box .ai-decision ul{margin:0;padding-left:18px;}
    .ai-box .ai-ship{background:#fff;border:1px dashed var(--border);border-radius:8px;padding:6px 9px;white-space:pre-wrap;font-size:12px;}
    .ai-box .btn{padding:5px 10px;font-size:12px;}
    .badge-ai{background:#f3e8ff;color:#6b21a8;}
    .btn-ai{background:#7c3aed;color:#fff;border-color:#7c3aed;}
    .btn-ai:hover{background:#6d28d9;}
    .btn-ai:disabled{background:#c4b5fd;border-color:#c4b5fd;cursor:not-allowed;}
    .queue-card .qc-ai{margin-top:7px;font-size:12px;color:#6b21a8;background:#faf5ff;border-radius:6px;padding:6px 9px;display:flex;flex-direction:column;gap:5px;}
    .queue-card .qc-ai .qc-ship{white-space:pre-wrap;color:var(--text);}
    .ai-settings textarea{min-height:70px;resize:vertical;}
    .ai-settings .ai-toggle{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:var(--text);}
    .ai-settings .ai-toggle input{width:auto;}
    .ai-settings .ai-stats{background:var(--bg);border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px;}
  `;
  document.head.appendChild(style);

  // ---------- Panneau IA dans un ticket ----------
  function renderAiBox() {
    const t = state.selectedTicket;
    const anchor = document.getElementById('influenceBox');
    if (!t || !anchor) return;
    let box = document.getElementById('aiBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'aiBox';
      box.className = 'ai-box';
      anchor.insertAdjacentElement('afterend', box);
    }
    const a = t.ai_analysis || null;
    const decision = t.gifting_decision || null;
    const isInfluence = (a && a.category === 'Influence') || t.category === 'Influence';
    const parts = [];

    parts.push(`<div class="ai-head"><strong>✨ Assistante IA</strong>
      ${a ? `<span class="badge badge-ai">${escapeHtml(SENTIMENTS[a.sentiment] || a.sentiment || '')}</span>
      <span class="badge badge-ai">${escapeHtml(a.register || '')}</span>
      ${a.gifting_stage && a.gifting_stage !== 'hors_gifting' ? `<span class="badge badge-ai">gifting : ${escapeHtml(STAGES[a.gifting_stage] || a.gifting_stage)}</span>` : ''}
      <span class="ai-muted">analysé ${escapeHtml(fmtDate(t.ai_analyzed_at))}${a.previous_category ? ` · reclassé depuis « ${escapeHtml(a.previous_category)} »` : ''}</span>`
      : '<span class="ai-muted">Conversation pas encore analysée.</span>'}
    </div>`);

    parts.push(`<div class="ai-row">
      <input type="text" id="aiInstruction" placeholder="Consigne facultative (ex. « refuse poliment », « propose l'Elisabeth Silver »)…" />
      <button class="btn btn-ai" id="aiDraftBtn">✨ Préparer une réponse</button>
    </div>`);

    if (a && (a.summary || (Array.isArray(a.alerts) && a.alerts.length))) {
      parts.push(`<div class="ai-row"><span class="ai-summary">${escapeHtml(a.summary || '')}</span>
        ${(Array.isArray(a.alerts) ? a.alerts : []).map(aiAlertBadge).join('')}</div>`);
    }

    if (isInfluence) {
      if (decision) {
        parts.push(`<div class="ai-row"><span>Décision gifting : <strong>${decision === 'approved' ? '✅ acceptée' : '❌ refusée'}</strong>
          ${t.gifting_decided_by ? 'par ' + escapeHtml(t.gifting_decided_by) : ''} ${t.gifting_decided_at ? escapeHtml(fmtDate(t.gifting_decided_at)) : ''}</span>
          <a href="#" id="aiResetDecision" class="ai-muted">changer</a></div>`);
      } else if (a && a.needs_decision) {
        const rec = a.profile_recommendation;
        parts.push(`<div class="ai-decision">
          <div><strong>Demande de collaboration : ta décision est requise.</strong>
            ${rec ? ` Recommandation IA : <strong>${escapeHtml(VERDICTS[rec.verdict] || rec.verdict)}</strong>
              ${Array.isArray(rec.reasons) && rec.reasons.length ? `<span class="ai-muted">(${rec.reasons.map((r) => escapeHtml(r)).join(' · ')})</span>` : ''}` : ''}</div>
          <div class="ai-row">
            <button class="btn btn-primary" data-ai-decision="approved">✅ Accepter le gifting</button>
            <button class="btn btn-danger" data-ai-decision="declined">❌ Refuser</button>
            <span class="ai-muted">L'IA rédige ensuite le brouillon correspondant.</span>
          </div>
        </div>`);
      } else {
        parts.push(`<div class="ai-row ai-muted">Collaboration gifting :
          <a href="#" data-ai-decision="approved">accepter</a> ·
          <a href="#" data-ai-decision="declined">refuser</a></div>`);
      }
    }

    if (a && a.shipping_details && shippingText(a.shipping_details)) {
      parts.push(`<div class="ai-row"><span class="ai-muted">📦 Coordonnées reçues :</span>
        <span>${escapeHtml(shippingText(a.shipping_details).split('\n').join(', '))}</span>
        <a href="#" id="aiCopyShip" class="ai-muted">Copier</a></div>`);
    }

    if (isInfluence) parts.push('<div class="ai-row" id="aiGiftingRow"><span class="ai-muted">🛍️ Commande gifting : chargement…</span></div>');

    box.innerHTML = parts.join('');
    if (isInfluence) loadGiftingRow(t.id);

    const draftBtn = document.getElementById('aiDraftBtn');
    draftBtn.onclick = () => requestAiDraft(draftBtn);
    document.getElementById('aiInstruction').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestAiDraft(draftBtn); });
    box.querySelectorAll('[data-ai-decision]').forEach((el) => {
      el.onclick = (e) => { e.preventDefault(); setGiftingDecision(el.dataset.aiDecision, el); };
    });
    const reset = document.getElementById('aiResetDecision');
    if (reset) reset.onclick = (e) => { e.preventDefault(); resetGiftingDecision(); };
    const copy = document.getElementById('aiCopyShip');
    if (copy) copy.onclick = async (e) => {
      e.preventDefault();
      try { await navigator.clipboard.writeText(shippingText(a.shipping_details)); toast('Coordonnées copiées.'); }
      catch (err) { toast('Copie impossible — sélectionne le texte à la main.', true); }
    };
  }

  // ---------- Commande gifting Shopify (ajout 2026-09-16) ----------
  // « Alice prépare, tu cliques » : la fenêtre est pré-remplie à partir de la
  // conversation (modèle, pointure, coordonnées) ; la commande à 0 € n'est
  // créée qu'au clic de Luc. Garde-fous serveur : lib/gifting/orders.js.
  const GIFT_ERRORS = {
    gifting_not_approved: "La collaboration n'est pas acceptée : clique d'abord « Accepter le gifting ».",
    shopify_gifting_not_connected: 'Shopify n\'est pas encore connecté pour les commandes gifting (« ✨ Assistante IA » → Connecter Shopify).',
    shopify_gifting_missing_scope: "L'app Shopify connectée n'a pas le droit de créer des commandes (write_draft_orders).",
    order_in_progress: 'Une commande est déjà en cours de création pour cette conversation.',
    missing_fields: 'Champs obligatoires manquants',
    invalid_country_code: 'Code pays invalide (2 lettres, ex. FR, BE).',
    invalid_email: 'E-mail invalide.',
    variant_not_found: 'Pointure introuvable pour ce modèle.',
    product_lookup_failed: 'Impossible de lire la fiche produit sur la boutique.',
    quota_check_failed: 'Impossible de vérifier le quota sur Shopify.',
  };

  async function loadGiftingRow(ticketId) {
    const row = document.getElementById('aiGiftingRow');
    if (!row) return;
    try {
      const data = await api('/api/tickets/' + ticketId + '/gifting-order');
      if (!state.selectedTicket || state.selectedTicket.id !== ticketId) return;
      const created = data.orders.filter((o) => o.status === 'created');
      const failed = data.orders.filter((o) => o.status === 'failed').slice(0, 1);
      const parts = ['<span class="ai-muted">🛍️ Commande gifting :</span>'];
      created.forEach((o) => parts.push(`<span class="badge badge-score" title="par ${escapeHtml(o.created_by || '')}">✅ ${escapeHtml(o.order_name || '')} · ${escapeHtml(o.product_title || '')} ${escapeHtml(o.size || '')} · ${escapeHtml(fmtDate(o.created_at))}</span>`));
      failed.forEach((o) => parts.push(`<span class="badge badge-alert bad" title="${escapeHtml(o.error || '')}">❌ échec ${escapeHtml(fmtDate(o.created_at))}</span>`));
      if (!data.approved_by) {
        parts.push('<span class="ai-muted">possible une fois la collaboration acceptée.</span>');
      } else if (!data.connected) {
        parts.push('<span class="ai-muted">Shopify pas encore connecté (« ✨ Assistante IA » → Connecter Shopify).</span>');
      } else {
        parts.push(`<button class="btn" id="aiGiftOpenBtn">🛍️ ${created.length ? 'Nouvelle commande' : 'Préparer la commande Shopify'}</button>`);
      }
      row.innerHTML = parts.join(' ');
      const btn = document.getElementById('aiGiftOpenBtn');
      if (btn) btn.onclick = () => openGiftingModal(ticketId);
    } catch (err) {
      row.innerHTML = '<span class="ai-muted">🛍️ Commande gifting : indisponible (' + escapeHtml(err.message) + ')</span>';
    }
  }

  const giftModal = document.createElement('div');
  giftModal.className = 'modal-backdrop';
  giftModal.id = 'aiGiftModal';
  giftModal.innerHTML = `
    <div class="modal modal-wide ai-settings">
      <h3>🛍️ Commande gifting à 0 € — <span id="giftContact"></span></h3>
      <div class="ai-stats" id="giftInfo">Chargement…</div>
      <label>Modèle (recherche sur la boutique)</label>
      <div style="display:flex;gap:6px;"><input type="text" id="giftSearch" placeholder="Ex. Elisabeth léopard" /><button class="btn" id="giftSearchBtn">Rechercher</button></div>
      <label>Produit</label>
      <select id="giftProduct"></select>
      <label>Pointure</label>
      <select id="giftVariant"></select>
      <div class="ai-stats" id="giftQuota" style="display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
        <div><label>Prénom</label><input type="text" id="giftFirst" /></div>
        <div><label>Nom</label><input type="text" id="giftLast" /></div>
      </div>
      <label>Adresse</label>
      <input type="text" id="giftAddr1" />
      <label>Complément d'adresse</label>
      <input type="text" id="giftAddr2" />
      <div style="display:grid;grid-template-columns:1fr 2fr 1fr;gap:0 10px;">
        <div><label>Code postal</label><input type="text" id="giftZip" /></div>
        <div><label>Ville</label><input type="text" id="giftCity" /></div>
        <div><label>Pays (FR, BE…)</label><input type="text" id="giftCountry" maxlength="2" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
        <div><label>Téléphone</label><input type="text" id="giftPhone" /></div>
        <div><label>E-mail</label><input type="text" id="giftEmail" /></div>
      </div>
      <div class="ai-stats" id="giftSummary" style="margin-top:10px;"></div>
      <div class="actions">
        <button class="btn" id="giftCancel">Annuler</button>
        <button class="btn btn-primary" id="giftCreate">Créer la commande à 0 €</button>
      </div>
    </div>`;
  document.body.appendChild(giftModal);

  const gift = { ticketId: null, products: [], settings: {}, idempotencyKey: null };

  function giftSelectedProduct() {
    return gift.products.find((p) => p.handle === document.getElementById('giftProduct').value) || null;
  }
  function giftSelectedVariant() {
    const p = giftSelectedProduct();
    return p ? (p.variants || []).find((v) => v.variant_id === document.getElementById('giftVariant').value) || null : null;
  }

  function renderGiftProducts(selectedHandle, selectedVariantId, prefetchedQuota) {
    const sel = document.getElementById('giftProduct');
    sel.innerHTML = gift.products.length
      ? gift.products.map((p) => `<option value="${escapeHtml(p.handle)}" ${p.handle === selectedHandle ? 'selected' : ''}>${escapeHtml(p.title || p.handle)}${p.available === false ? ' (épuisé)' : ''}</option>`).join('')
      : '<option value="">Aucun produit — lance une recherche</option>';
    renderGiftVariants(selectedVariantId, prefetchedQuota);
  }

  function renderGiftVariants(selectedVariantId, prefetchedQuota) {
    const p = giftSelectedProduct();
    const sel = document.getElementById('giftVariant');
    const variants = p ? p.variants || [] : [];
    sel.innerHTML = variants.length
      ? '<option value="">— choisir —</option>' + variants.map((v) => `<option value="${escapeHtml(v.variant_id)}" ${v.variant_id === selectedVariantId ? 'selected' : ''}>${escapeHtml(v.size)}${v.available ? '' : ' — indisponible'}</option>`).join('')
      : '<option value="">—</option>';
    refreshGiftQuota(prefetchedQuota);
  }

  async function refreshGiftQuota(prefetched) {
    const box = document.getElementById('giftQuota');
    const v = giftSelectedVariant();
    updateGiftSummary();
    if (!v || !v.sku) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.textContent = 'Quota : vérification…';
    try {
      const quota = prefetched || (await api('/api/gifting/products?quota_sku=' + encodeURIComponent(v.sku))).quota;
      if (giftSelectedVariant() !== v) return;
      if (quota.count == null) {
        box.innerHTML = `⚠️ Quota non vérifiable (${escapeHtml(quota.error || 'erreur')}) — modèle ${escapeHtml(quota.colorway_key || '')}.`;
      } else {
        const full = quota.count >= quota.limit;
        box.innerHTML = `${full ? '⛔' : '✅'} Quota ${escapeHtml(quota.collection || '')} pour ce modèle/coloris (${escapeHtml(quota.colorway_key)}) : <strong>${quota.count}/${quota.limit}</strong> paire(s) déjà offerte(s)${quota.orders && quota.orders.length ? ' (' + quota.orders.map(escapeHtml).join(', ') + ')' : ''}.`;
      }
    } catch (err) {
      box.textContent = 'Quota : erreur (' + err.message + ')';
    }
  }

  function updateGiftSummary() {
    const v = giftSelectedVariant();
    const p = giftSelectedProduct();
    const cc = document.getElementById('giftCountry').value.trim().toUpperCase();
    const ship = cc === 'FR' ? (gift.settings.shipping_title_fr || 'Colissimo') : (gift.settings.shipping_title_intl || 'UPS International');
    document.getElementById('giftSummary').innerHTML = p && v
      ? `Commande Shopify : <strong>${escapeHtml(p.title)} — ${escapeHtml(v.size)}</strong>${v.available ? '' : ' <span style="color:var(--red)">(indisponible)</span>'} · remise 100 % « ${escapeHtml(gift.settings.discount_title || 'Gifting influence Instagram')} » · livraison ${escapeHtml(ship)} offerte · total 0 €. Aucun e-mail de confirmation n'est prévu : pense à prévenir la personne en DM.`
      : 'Choisis le modèle et la pointure.';
  }

  async function openGiftingModal(ticketId) {
    gift.ticketId = ticketId;
    gift.idempotencyKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    const t = state.selectedTicket;
    document.getElementById('giftContact').textContent = t ? (t.contact_name || t.contact_handle || '') : '';
    document.getElementById('giftInfo').textContent = 'Préparation de la commande par l\'assistante…';
    giftModal.classList.add('open');
    try {
      const data = await api('/api/tickets/' + ticketId + '/gifting-order?mode=proposal');
      gift.products = data.candidates || [];
      gift.settings = data.settings || {};
      const item = data.requested_item;
      document.getElementById('giftInfo').innerHTML = item
        ? `Demande repérée dans la conversation : <strong>${escapeHtml([item.model, item.color, item.size && ('pointure ' + item.size)].filter(Boolean).join(' · '))}</strong>. Vérifie tout avant de valider.`
        : "L'assistante n'a pas repéré de modèle dans la conversation : recherche-le ci-dessous.";
      if (data.product_error) document.getElementById('giftInfo').innerHTML += '<br>⚠️ Boutique injoignable : ' + escapeHtml(data.product_error);
      document.getElementById('giftSearch').value = item ? [item.model, item.color].filter(Boolean).join(' ') : '';
      const a = data.address || {};
      document.getElementById('giftFirst').value = a.first_name || '';
      document.getElementById('giftLast').value = a.last_name || '';
      document.getElementById('giftAddr1').value = a.address1 || '';
      document.getElementById('giftAddr2').value = a.address2 || '';
      document.getElementById('giftZip').value = a.zip || '';
      document.getElementById('giftCity').value = a.city || '';
      document.getElementById('giftCountry').value = a.country_code || '';
      document.getElementById('giftPhone').value = a.phone || '';
      document.getElementById('giftEmail').value = a.email || '';
      renderGiftProducts(data.selected && data.selected.product_handle, data.selected && data.selected.variant_id, data.quota || undefined);
    } catch (err) {
      document.getElementById('giftInfo').textContent = 'Erreur : ' + err.message;
    }
  }

  async function searchGiftProducts() {
    const q = document.getElementById('giftSearch').value.trim();
    if (!q) return;
    const btn = document.getElementById('giftSearchBtn');
    btn.disabled = true;
    try {
      const data = await api('/api/gifting/products?q=' + encodeURIComponent(q));
      gift.products = data.products || [];
      renderGiftProducts(gift.products[0] && gift.products[0].handle, null);
    } catch (err) {
      toast('Recherche impossible : ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function submitGiftOrder(overrides = {}) {
    const p = giftSelectedProduct();
    const v = giftSelectedVariant();
    if (!p || !v) { toast('Choisis le modèle et la pointure.', true); return; }
    const name = overrides._name || askName('Créer cette commande gifting (0 €) en tant que :');
    if (!name) return;
    const body = {
      product_handle: p.handle, variant_id: v.variant_id,
      first_name: document.getElementById('giftFirst').value, last_name: document.getElementById('giftLast').value,
      address1: document.getElementById('giftAddr1').value, address2: document.getElementById('giftAddr2').value,
      zip: document.getElementById('giftZip').value, city: document.getElementById('giftCity').value,
      country_code: document.getElementById('giftCountry').value.trim().toUpperCase(),
      phone: document.getElementById('giftPhone').value, email: document.getElementById('giftEmail').value,
      created_by: name, idempotency_key: gift.idempotencyKey,
      override_quota: !!overrides.override_quota, override_stock: !!overrides.override_stock, override_duplicate: !!overrides.override_duplicate,
    };
    const btn = document.getElementById('giftCreate');
    btn.disabled = true;
    btn.textContent = '⏳ Création sur Shopify…';
    try {
      const data = await api('/api/tickets/' + gift.ticketId + '/gifting-order', { method: 'POST', body });
      giftModal.classList.remove('open');
      const orderName = data.gifting_order && data.gifting_order.order_name;
      toast(`✅ Commande ${orderName || ''} créée sur Shopify (0 €).`);
      await refreshSelectedTicket();
      const instr = document.getElementById('aiInstruction');
      if (instr) instr.value = `La commande gifting ${orderName || ''} est créée : confirme à la personne que sa paire (${p.title} en ${v.size}) part en préparation et qu'elle recevra le suivi.`;
    } catch (err) {
      const pl = err.payload || {};
      const retry = (extra, question) => { if (window.confirm(question)) submitGiftOrder({ ...overrides, ...extra, _name: name }); };
      if (pl.error === 'quota_reached') {
        retry({ override_quota: true }, `Quota atteint : ${pl.count}/${pl.limit} paires déjà offertes pour ce modèle/coloris (${pl.colorway_key}).\n\nCréer quand même la commande ?`);
      } else if (pl.error === 'variant_unavailable') {
        retry({ override_stock: true }, `La pointure ${pl.size || ''} est indiquée indisponible sur la boutique.\n\nCréer quand même la commande ?`);
      } else if (pl.error === 'already_ordered') {
        retry({ override_duplicate: true }, `Une commande gifting (${pl.order_name}) existe déjà pour cette conversation.\n\nEn créer une seconde ?`);
      } else if (pl.error === 'quota_check_failed') {
        retry({ override_quota: true }, `Le quota n'a pas pu être vérifié sur Shopify (${pl.detail || 'erreur'}).\n\nCréer quand même la commande ?`);
      } else {
        let msg = GIFT_ERRORS[pl.error] || pl.message || err.message;
        if (pl.error === 'missing_fields' && pl.fields) msg += ' : ' + pl.fields.join(', ');
        if (pl.draft_order_name) msg += ` — brouillon ${pl.draft_order_name} créé mais non validé : à finir dans Shopify.`;
        toast('Commande non créée : ' + msg, true);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Créer la commande à 0 €';
    }
  }

  document.getElementById('giftCancel').onclick = () => giftModal.classList.remove('open');
  document.getElementById('giftCreate').onclick = () => submitGiftOrder();
  document.getElementById('giftSearchBtn').onclick = searchGiftProducts;
  document.getElementById('giftSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchGiftProducts(); });
  document.getElementById('giftProduct').onchange = () => renderGiftVariants(null);
  document.getElementById('giftVariant').onchange = () => refreshGiftQuota();
  document.getElementById('giftCountry').oninput = updateGiftSummary;
  giftModal.addEventListener('click', (e) => { if (e.target === giftModal) giftModal.classList.remove('open'); });

  async function requestAiDraft(btn) {
    const t = state.selectedTicket;
    if (!t) return;
    const input = document.getElementById('aiInstruction');
    const instruction = input ? input.value.trim() : '';
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Rédaction…';
    try {
      const data = await api('/api/tickets/' + t.id + '/ai-draft', { method: 'POST', body: { instruction: instruction || undefined } });
      await refreshSelectedTicket();
      if (data.draft) {
        toast('Brouillon IA prêt — relis-le puis valide-le dans le fil ou la file de validation.');
      } else if (data.analysis && data.analysis.alerts.some((x) => x.code === 'decision_requise')) {
        toast('Pas de brouillon : ta décision (accepter / refuser) est d\'abord requise.');
      } else if (data.status === 'skipped') {
        toast('Rien à analyser pour cette conversation.');
      } else {
        toast("Analyse faite — l'IA juge qu'aucune réponse n'est utile pour l'instant (ajoute une consigne pour forcer).");
      }
    } catch (err) {
      toast(aiErrorMessage(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function setGiftingDecision(decision, el) {
    const t = state.selectedTicket;
    if (!t) return;
    const name = askName(decision === 'approved' ? 'Accepter cette collaboration en tant que :' : 'Refuser cette collaboration en tant que :');
    if (!name) return;
    const buttons = document.querySelectorAll('[data-ai-decision]');
    buttons.forEach((b) => { b.disabled = true; });
    if (el && el.tagName === 'BUTTON') el.textContent = '⏳ Enregistrement + rédaction…';
    else toast('Décision enregistrée, rédaction du brouillon en cours…');
    try {
      const data = await api('/api/tickets/' + t.id + '/gifting-decision', { method: 'POST', body: { decision, decided_by: name } });
      await refreshSelectedTicket();
      if (data.ai_error) toast('Décision enregistrée, mais le brouillon IA a échoué (' + data.ai_error + ') — relance « Préparer une réponse ».', true);
      else if (data.ai && data.ai.draft) toast(decision === 'approved' ? 'Collaboration acceptée — brouillon prêt à relire.' : 'Refus enregistré — brouillon de refus prêt à relire.');
      else toast('Décision enregistrée.');
    } catch (err) {
      toast('Erreur : ' + err.message, true);
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function resetGiftingDecision() {
    const t = state.selectedTicket;
    if (!t || !window.confirm('Effacer la décision gifting enregistrée pour cette conversation ?')) return;
    try {
      await api('/api/tickets/' + t.id + '/gifting-decision', { method: 'POST', body: { decision: null, generate_draft: false } });
      await refreshSelectedTicket();
      toast('Décision effacée.');
    } catch (err) {
      toast('Erreur : ' + err.message, true);
    }
  }

  // ---------- Marquage des brouillons IA dans le fil ----------
  function markAiDraftsInThread() {
    const threadEl = document.getElementById('thread');
    if (!threadEl) return;
    (state.messages || []).filter((m) => m.ai_generated && m.status === 'draft').forEach((m) => {
      const btn = threadEl.querySelector(`[data-action="validate"][data-id="${m.id}"]`);
      const bubble = btn && btn.closest('.msg');
      if (!bubble || bubble.querySelector('.badge-ai')) return;
      const meta = bubble.querySelector('.meta');
      const badge = document.createElement('span');
      badge.className = 'badge badge-ai';
      badge.textContent = '✨ IA';
      badge.title = (m.ai_meta && m.ai_meta.rationale) || 'Brouillon rédigé par l\'IA';
      if (meta) meta.prepend(badge); else bubble.prepend(badge);
    });
  }

  // ---------- File de validation ----------
  function decorateQueue() {
    const items = (state.queue && state.queue.items) || [];
    items.forEach((it) => {
      if (!it.ai_generated) return;
      const textarea = document.querySelector(`.queue-card textarea[data-id="${it.message_id}"]`);
      const card = textarea && textarea.closest('.queue-card');
      if (!card || card.querySelector('.qc-ai')) return;
      const badges = card.querySelector('.qc-badges');
      if (badges) badges.insertAdjacentHTML('afterbegin', '<span class="badge badge-ai">✨ IA</span>');
      const block = document.createElement('div');
      block.className = 'qc-ai';
      const ship = shippingText(it.shipping_details);
      block.innerHTML = `
        ${it.ai_summary ? `<div>📝 ${escapeHtml(it.ai_summary)}</div>` : ''}
        ${it.ai_rationale ? `<div>💡 ${escapeHtml(it.ai_rationale)}</div>` : ''}
        ${it.ai_alerts && it.ai_alerts.length ? `<div class="qc-alerts" style="margin-top:0;">${it.ai_alerts.map(aiAlertBadge).join('')}</div>` : ''}
        ${ship ? `<div>📦 Coordonnées reçues :<div class="qc-ship">${escapeHtml(ship)}</div></div>` : ''}
      `;
      const alertsEl = card.querySelector('.qc-alerts');
      (alertsEl || textarea).insertAdjacentElement('afterend', block);
    });
  }

  // ---------- Analyse après « Actualiser Instagram » ----------
  let aiNotConfiguredWarned = false;
  async function runAiProcessing(mode, { onProgress } = {}) {
    const total = { processed: 0, drafts_created: 0, decisions_required: 0, categories_changed: 0, errors: 0, remaining: 0 };
    for (let round = 0; round < 40; round++) {
      const data = await api('/api/ai/process', { method: 'POST', body: { mode } });
      if (data.disabled) return { ...total, disabled: true };
      total.processed += data.processed || 0;
      total.drafts_created += data.drafts_created || 0;
      total.decisions_required += data.decisions_required || 0;
      total.categories_changed += data.categories_changed || 0;
      total.errors += (data.errors || []).length;
      total.remaining = data.remaining || 0;
      if (onProgress) onProgress(total);
      if (data.fatal) { total.fatal = data.fatal; break; }
      if (!data.remaining || !data.processed) break;
    }
    return total;
  }

  async function aiAfterSync() {
    const btn = document.getElementById('syncInstagramBtn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '✨ Analyse IA…';
    try {
      const r = await runAiProcessing('auto', {
        onProgress: (p) => { btn.textContent = `✨ Analyse IA… (${p.processed})`; },
      });
      if (r.disabled) return;
      if (r.fatal) { toast(aiErrorMessage({ message: r.fatal }), true); return; }
      if (r.processed > 0) {
        const parts = [`${r.processed} conversation${r.processed > 1 ? 's' : ''} analysée${r.processed > 1 ? 's' : ''}`];
        if (r.drafts_created) parts.push(`${r.drafts_created} brouillon${r.drafts_created > 1 ? 's' : ''} prêt${r.drafts_created > 1 ? 's' : ''}`);
        if (r.decisions_required) parts.push(`${r.decisions_required} décision${r.decisions_required > 1 ? 's' : ''} à prendre`);
        toast('✨ ' + parts.join(', ') + '.', r.errors > 0);
        if (state.view === 'queue') { await loadQueue(); } else { await loadTickets(); if (state.selectedTicket) await refreshSelectedTicket(); }
      }
    } catch (err) {
      const code = err.payload && err.payload.error;
      if (code === 'ai_not_configured') {
        if (!aiNotConfiguredWarned) { aiNotConfiguredWarned = true; toast(aiErrorMessage(err), true); }
      } else {
        toast(aiErrorMessage(err), true);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ---------- Réglages IA (modale) ----------
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.id = 'aiSettingsModal';
  modal.innerHTML = `
    <div class="modal modal-wide ai-settings">
      <h3>✨ Assistante IA — <span id="aiSetTenant"></span></h3>
      <div class="ai-stats" id="aiSetStats">Chargement…</div>
      <label class="ai-toggle"><input type="checkbox" id="aiSetEnabled" /> IA activée pour cette marque</label>
      <label class="ai-toggle"><input type="checkbox" id="aiSetAutoDraft" /> Brouillons automatiques après « Actualiser Instagram » (Influence uniquement)</label>
      <label>Prénom de signature</label>
      <input type="text" id="aiSetSignature" />
      <label>Nom de la marque (tel qu'écrit dans les messages)</label>
      <input type="text" id="aiSetBrand" />
      <label>Ton de la marque</label>
      <textarea id="aiSetVoice"></textarea>
      <label>Règles du gifting</label>
      <textarea id="aiSetGifting"></textarea>
      <label>Critères d'analyse des profils (recommandation accepter / refuser)</label>
      <textarea id="aiSetCriteria"></textarea>
      <label>Interdits (ce que l'IA ne doit jamais promettre)</label>
      <textarea id="aiSetForbidden"></textarea>
      <label>Autres consignes</label>
      <textarea id="aiSetExtra"></textarea>
      <h3 style="margin-top:18px;">🛍️ Commandes gifting Shopify</h3>
      <div class="ai-stats" id="aiSetGiftStatus">…</div>
      <div style="margin-top:8px;"><button class="btn" id="aiSetGiftConnect">🔗 Connecter Shopify (commandes gifting)</button></div>
      <label>Quota : paires offertes maximum par modèle/coloris sur une collection</label>
      <input type="number" id="aiSetGiftQuota" min="0" max="1000" />
      <label>Intitulé de la remise 100 % (sert aussi à compter le quota)</label>
      <input type="text" id="aiSetGiftDiscount" />
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
        <div><label>Livraison France</label><input type="text" id="aiSetGiftShipFr" /></div>
        <div><label>Livraison étranger</label><input type="text" id="aiSetGiftShipIntl" /></div>
      </div>
      <div class="actions" style="justify-content:space-between;flex-wrap:wrap;">
        <button class="btn" id="aiSetClassifyBtn" title="Analyse et reclasse les conversations jamais analysées. Ne crée aucun brouillon.">🗂️ Analyser l'historique</button>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="aiSetCancel">Fermer</button>
          <button class="btn btn-primary" id="aiSetSave">Enregistrer</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const FIELD_IDS = {
    signature_name: 'aiSetSignature', brand_name: 'aiSetBrand', brand_voice: 'aiSetVoice', gifting_rules: 'aiSetGifting',
    profile_criteria: 'aiSetCriteria', forbidden_topics: 'aiSetForbidden', extra_instructions: 'aiSetExtra',
    gifting_discount_title: 'aiSetGiftDiscount', gifting_shipping_title_fr: 'aiSetGiftShipFr', gifting_shipping_title_intl: 'aiSetGiftShipIntl',
  };

  function renderAiStats(data) {
    const s = data.stats || {};
    document.getElementById('aiSetStats').innerHTML = `
      ${data.ai_configured ? `✅ IA branchée (modèle ${escapeHtml(data.model)})` : '⚠️ IA non branchée : ajoute la variable ANTHROPIC_API_KEY sur Vercel.'}<br>
      ${s.ai_drafts_pending || 0} brouillon(s) IA en attente de validation · ${s.decisions_required || 0} décision(s) gifting à prendre ·
      ${s.analyzed || 0} conversation(s) analysée(s) · ${s.never_analyzed || 0} jamais analysée(s)`;
    document.getElementById('aiSetClassifyBtn').textContent = `🗂️ Analyser l'historique (${s.never_analyzed || 0})`;
    document.getElementById('aiSetClassifyBtn').disabled = !data.ai_configured || !s.never_analyzed;
  }

  async function openAiSettings() {
    document.getElementById('aiSetTenant').textContent = state.tenant === 'bbp' ? 'BBP' : 'Misü';
    modal.classList.add('open');
    try {
      const data = await api('/api/ai/settings');
      const st = data.settings || {};
      Object.entries(FIELD_IDS).forEach(([field, id]) => { document.getElementById(id).value = st[field] || ''; });
      document.getElementById('aiSetEnabled').checked = st.enabled !== false;
      document.getElementById('aiSetAutoDraft').checked = st.auto_draft !== false;
      document.getElementById('aiSetGiftQuota').value = st.gifting_quota_per_colorway != null ? st.gifting_quota_per_colorway : 5;
      const g = data.gifting || {};
      document.getElementById('aiSetGiftStatus').innerHTML = g.connected
        ? `✅ Shopify connecté : ${escapeHtml(g.shop_name || g.shop || '')} (droits : ${escapeHtml(g.scope || '?')})`
        : '⚠️ Shopify pas encore connecté pour les commandes gifting. Il faut d\'abord créer l\'app dédiée sur le Dev Dashboard et poser ses identifiants sur Vercel (voir la procédure), puis cliquer ci-dessous.';
      document.getElementById('aiSetGiftConnect').textContent = g.connected ? '🔗 Reconnecter Shopify' : '🔗 Connecter Shopify (commandes gifting)';
      renderAiStats(data);
    } catch (err) {
      document.getElementById('aiSetStats').textContent = 'Erreur de chargement : ' + err.message;
    }
  }

  async function saveAiSettings() {
    const name = askName('Enregistrer les réglages IA en tant que :');
    if (!name) return;
    const body = { updated_by: name, enabled: document.getElementById('aiSetEnabled').checked, auto_draft: document.getElementById('aiSetAutoDraft').checked };
    Object.entries(FIELD_IDS).forEach(([field, id]) => { body[field] = document.getElementById(id).value; });
    if (!body.signature_name.trim()) { toast('Le prénom de signature est obligatoire.', true); return; }
    const quota = document.getElementById('aiSetGiftQuota').value.trim();
    if (quota !== '') body.gifting_quota_per_colorway = parseInt(quota, 10);
    try {
      await api('/api/ai/settings', { method: 'PUT', body });
      toast('Réglages IA enregistrés — appliqués dès le prochain brouillon.');
      modal.classList.remove('open');
    } catch (err) {
      toast('Erreur : ' + err.message, true);
    }
  }

  async function classifyHistory() {
    const btn = document.getElementById('aiSetClassifyBtn');
    if (!window.confirm("Analyser toutes les conversations jamais analysées ?\n\nL'IA les reclasse (catégorie + résumé) sans créer aucun brouillon. Compte environ 1 à 2 centimes par conversation.")) return;
    btn.disabled = true;
    try {
      const r = await runAiProcessing('classify', {
        onProgress: (p) => { btn.textContent = `⏳ ${p.processed} analysée(s), reste ${p.remaining}…`; },
      });
      if (r.fatal) toast(aiErrorMessage({ message: r.fatal }), true);
      else toast(`🗂️ ${r.processed} conversation(s) analysée(s), ${r.categories_changed} reclassée(s)${r.remaining ? `, ${r.remaining} restante(s) — relance pour continuer` : ''}.`, r.errors > 0);
      const data = await api('/api/ai/settings');
      renderAiStats(data);
      await loadTickets();
    } catch (err) {
      toast(aiErrorMessage(err), true);
      btn.disabled = false;
    }
  }

  document.getElementById('aiSetCancel').onclick = () => modal.classList.remove('open');
  document.getElementById('aiSetSave').onclick = saveAiSettings;
  document.getElementById('aiSetClassifyBtn').onclick = classifyHistory;
  document.getElementById('aiSetGiftConnect').onclick = () => {
    window.open('/api/gifting/shopify-connect?tenant=' + encodeURIComponent(state.tenant), '_blank', 'noopener');
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  const headerBtn = document.createElement('button');
  headerBtn.className = 'btn';
  headerBtn.id = 'aiSettingsBtn';
  headerBtn.textContent = '✨ Assistante IA';
  headerBtn.onclick = openAiSettings;
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.insertAdjacentElement('afterend', headerBtn);

  // ---------- Enveloppes des fonctions d'index.html ----------
  const originalSyncInstagram = syncInstagram;
  syncInstagram = async function () {
    await originalSyncInstagram.apply(this, arguments);
    await aiAfterSync();
  };
  document.getElementById('syncInstagramBtn').onclick = syncInstagram;

  const originalRenderDetail = renderDetail;
  renderDetail = async function () {
    await originalRenderDetail.apply(this, arguments);
    renderAiBox();
  };

  const originalRenderThread = renderThread;
  renderThread = function () {
    originalRenderThread.apply(this, arguments);
    markAiDraftsInThread();
  };

  const originalRenderQueue = renderQueue;
  renderQueue = function () {
    originalRenderQueue.apply(this, arguments);
    decorateQueue();
  };
})();
