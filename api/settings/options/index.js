// GET  /api/settings/options?field=status|category   liste, dans l'ordre choisi
// POST /api/settings/options                          { field, label } — ajoute une valeur
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');

const VALID_FIELDS = ['status', 'category'];

module.exports = withTenantHandler(async (req, res, tenant) => {
  if (req.method === 'GET') {
    const field = req.query.field;
    if (!VALID_FIELDS.includes(field)) {
      sendJson(res, 400, { error: 'invalid_field' });
      return;
    }
    const options = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM ticket_field_options WHERE field = $1 ORDER BY sort_order, label',
        [field]
      );
      return rows;
    });
    sendJson(res, 200, { options });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const field = body.field;
    const label = (body.label || '').trim();
    if (!VALID_FIELDS.includes(field)) {
      sendJson(res, 400, { error: 'invalid_field' });
      return;
    }
    if (!label) {
      sendJson(res, 400, { error: 'label_required' });
      return;
    }
    try {
      const option = await withTenant(tenant.id, async (client) => {
        const { rows: maxRows } = await client.query(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ticket_field_options WHERE field = $1',
          [field]
        );
        const { rows } = await client.query(
          `INSERT INTO ticket_field_options (tenant_id, field, label, sort_order)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [tenant.id, field, label, maxRows[0].next]
        );
        return rows[0];
      });
      sendJson(res, 201, { option });
    } catch (err) {
      if (err.code === '23505') {
        sendJson(res, 409, { error: 'already_exists' });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
