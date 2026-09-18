// POST /api/ai/rule
// Ajout 2026-09-18, demandé par Luc : « quand je lis une réponse et que je me
// dis, tiens, elle a oublié deux, trois trucs, ça aurait été bien si… », il
// veut le dire là où il est — dans le fil — et que ça serve la prochaine fois.
//
// Deux temps, à la demande de Luc (« je veux qu'Alice la reformule en consigne
// propre, avant de la montrer, pour accord ») :
//
//   1. { remarque }            → Alice en tire une consigne générale, rendue
//                                telle quelle SANS RIEN ENREGISTRER.
//   2. { rule, confirm: true } → la consigne validée par Luc est ajoutée aux
//                                « Autres consignes » de la marque.
//
// Rien n'est jamais enregistré sans ce second appel : la remarque de Luc peut
// être maladroite ou trop liée à un cas précis, et une consigne permanente mal
// écrite dégrade TOUTES les réponses suivantes. D'où la relecture.
const { withTenantHandler, sendJson } = require('../../lib/handler');
const { withTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { createMessage, isConfigured } = require('../../lib/ai/anthropic');
const { loadAiSettings } = require('../../lib/ai/assistant');

const MAX_REGLE = 300;
const MAX_CONSIGNES = 4000;

const SYSTEM = `Tu transformes la remarque d'un responsable de service client en UNE consigne permanente, destinée à l'assistante qui rédige les réponses aux clientes.

Règles d'écriture :
- Une seule phrase, à l'impératif, en français, 200 caractères maximum.
- Générale : elle s'appliquera à toutes les conversations, pas seulement à celle qui a provoqué la remarque. Retire les noms de personnes, les numéros de commande, les dates.
- Concrète et vérifiable. « Sois plus sympathique » ne veut rien dire ; « Termine par une formule chaleureuse quand la cliente est satisfaite » se vérifie.
- Garde la formulation du responsable quand elle est déjà claire. Tu reformules, tu n'inventes pas et tu n'ajoutes aucune règle qu'il n'a pas demandée.
- Si la remarque porte sur un fait ponctuel (« le suivi était faux ») et non sur une manière de répondre, dis-le en renvoyant exactement : HORS_CONSIGNE

Réponds UNIQUEMENT par la consigne, ou par HORS_CONSIGNE. Aucun préambule, aucun guillemet.`;

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = req.body || {};

  // --- Temps 2 : enregistrement de la consigne validée ---
  if (body.confirm) {
    const regle = String(body.rule || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REGLE);
    if (!regle) {
      sendJson(res, 400, { error: 'rule_required' });
      return;
    }
    const par = String(body.updated_by || 'luc').slice(0, 80);
    const result = await withTenant(tenant.id, async (client) => {
      const settings = await loadAiSettings(client, tenant);
      const actuelles = String(settings.extra_instructions || '').trim();
      if (actuelles.includes(regle)) return { extra_instructions: actuelles, deja_presente: true };
      const fusion = (actuelles ? actuelles + '\n' : '') + '- ' + regle;
      if (fusion.length > MAX_CONSIGNES) {
        const err = new Error('consignes_trop_longues');
        err.code = 'consignes_trop_longues';
        throw err;
      }
      // Même façon de faire que api/ai/settings.js : on crée la ligne si elle
      // n'existe pas (avec ses valeurs par défaut) avant de la mettre à jour.
      await client.query(
        `INSERT INTO tenant_ai_settings (tenant_id, signature_name)
         VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant.id, tenant.slug === 'misu' ? 'Louise' : 'Alice']
      );
      await client.query(
        `UPDATE tenant_ai_settings SET extra_instructions = $2, updated_by = $3, updated_at = now()
          WHERE tenant_id = $1`,
        [tenant.id, fusion, par]
      );
      await logAudit(client, tenant.id, {
        actor: par,
        action: 'ai_rule_added',
        entityType: 'tenant_ai_settings',
        entityId: tenant.id,
        details: { regle, ticket_id: body.ticket_id || null },
      });
      return { extra_instructions: fusion, deja_presente: false };
    }).catch((err) => {
      if (err.code === 'consignes_trop_longues') return { erreur: 'consignes_trop_longues' };
      throw err;
    });
    if (result.erreur) {
      sendJson(res, 400, {
        error: 'consignes_trop_longues',
        message: 'Les consignes permanentes sont pleines. Fais le ménage dans « Autres consignes » avant d\'en ajouter une.',
      });
      return;
    }
    sendJson(res, 200, { saved: true, rule: regle, ...result });
    return;
  }

  // --- Temps 1 : proposition de consigne, rien n'est écrit ---
  const remarque = String(body.remarque || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!remarque) {
    sendJson(res, 400, { error: 'remarque_required' });
    return;
  }
  if (!isConfigured()) {
    // Sans IA branchée, on rend la remarque telle quelle : Luc la corrigera
    // lui-même plutôt que de perdre ce qu'il vient d'écrire.
    sendJson(res, 200, { rule: remarque.slice(0, MAX_REGLE), reformulee: false });
    return;
  }

  try {
    const reponse = await createMessage({
      system: SYSTEM,
      messages: [{ role: 'user', content: `Remarque du responsable :\n${remarque}` }],
      max_tokens: 200,
    });
    const texte = (reponse.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      .replace(/\s+/g, ' ').replace(/^[«"']|[»"']$/g, '').trim();
    if (!texte || /^HORS_CONSIGNE$/i.test(texte)) {
      sendJson(res, 200, {
        rule: null,
        hors_consigne: true,
        message: "Cette remarque porte sur un cas précis, pas sur une façon de répondre : en faire une règle permanente n'aiderait pas. Le brouillon a quand même été refait avec ta remarque.",
      });
      return;
    }
    sendJson(res, 200, { rule: texte.slice(0, MAX_REGLE), reformulee: true });
  } catch (err) {
    console.error('[consigne] reformulation impossible :', String(err.message || err).slice(0, 200));
    sendJson(res, 200, { rule: remarque.slice(0, MAX_REGLE), reformulee: false });
  }
});
