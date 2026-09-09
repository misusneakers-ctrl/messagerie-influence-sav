// GET  /api/webhooks/instagram   vérification d'abonnement Meta (hub.challenge)
// POST /api/webhooks/instagram   réception d'un DM entrant
//
// Résout le tenant par l'IG business account id reçu dans l'événement (pas par
// header — un webhook Meta ne porte pas X-Shop-Domain). Crée ou retrouve le
// ticket du fil, ajoute un message "inbound". Ne crée JAMAIS de message
// "outbound" ici — la création de brouillon est un acte séparé, humain ou
// assisté, jamais automatique à la réception.

const crypto = require('crypto');
const { withTenant, withoutTenant } = require('../../lib/db');
const { logAudit } = require('../../lib/audit');
const { readRawBody } = require('../../lib/rawBody');

function verifySignature(req, rawBody) {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.META_APP_SECRET;
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function resolveTenantByIgAccountId(igBusinessAccountId) {
  return withoutTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id FROM tenant_credentials
       WHERE type = 'meta_instagram' AND metadata->>'ig_business_account_id' = $1`,
      [igBusinessAccountId]
    );
    if (!rows[0]) return null;
    const { rows: tenantRows } = await client.query('SELECT * FROM tenants WHERE id = $1', [rows[0].tenant_id]);
    return tenantRows[0] || null;
  });
}

async function handler(req, res) {
  if (req.method === 'GET') {
    // Vérification d'abonnement webhook Meta.
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('forbidden');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifySignature(req, rawBody)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  const entries = body.entry || [];

  for (const entry of entries) {
    const igBusinessAccountId = entry.id;
    const tenant = await resolveTenantByIgAccountId(igBusinessAccountId);
    if (!tenant) {
      console.warn('Webhook Instagram reçu pour un compte IG non reconnu', igBusinessAccountId);
      continue;
    }

    const messagingEvents = entry.messaging || [];
    for (const event of messagingEvents) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue;

      await withTenant(tenant.id, async (client) => {
        const { rows: existingTickets } = await client.query(
          `SELECT * FROM tickets WHERE tenant_id = $1 AND channel = 'instagram' AND external_thread_id = $2`,
          [tenant.id, senderId]
        );
        let ticket = existingTickets[0];
        if (!ticket) {
          const { rows } = await client.query(
            `INSERT INTO tickets (tenant_id, channel, category, status, contact_handle, external_thread_id)
             VALUES ($1,'instagram','Influence','a_traiter',$2,$3)
             RETURNING *`,
            [tenant.id, senderId, senderId]
          );
          ticket = rows[0];
          await logAudit(client, tenant.id, {
            actor: 'webhook',
            action: 'ticket_created',
            entityType: 'ticket',
            entityId: ticket.id,
            details: { channel: 'instagram', source: 'webhook' },
          });
        }

        const { rows: msgRows } = await client.query(
          `INSERT INTO ticket_messages (tenant_id, ticket_id, direction, body, status, external_message_id)
           VALUES ($1,$2,'inbound',$3,'received',$4)
           RETURNING *`,
          [tenant.id, ticket.id, text, event.message?.mid || null]
        );

        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticket.id]);

        await logAudit(client, tenant.id, {
          actor: 'webhook',
          action: 'message_received',
          entityType: 'ticket_message',
          entityId: msgRows[0].id,
          details: { ticket_id: ticket.id },
        });
      });
    }
  }

  res.status(200).json({ ok: true });
}

module.exports = handler;
// bodyParser désactivé : on doit lire le corps brut pour vérifier la
// signature HMAC Meta avant tout parsing JSON.
module.exports.config = { api: { bodyParser: false } };
