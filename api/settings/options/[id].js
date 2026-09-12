// PATCH  /api/settings/options/:id   { label? , move: 'up'|'down', set_default: true }
// DELETE /api/settings/options/:id   refusé si valeur par défaut ou utilisée par des tickets
const { withTenantHandler, sendJson } = require('../../../lib/handler');
const { withTenant } = require('../../../lib/db');

const TICKET_COLUMN = { status: 'status', category: 'category' };

module.exports = withTenantHandler(async (req, res, tenant) => {
  const id = req.query.id;

  if (req.method === 'PATCH') {
    const body = req.body || {};
    try {
      const option = await withTenant(tenant.id, async (client) => {
        const { rows: existingRows } = await client.query('SELECT * FROM ticket_field_options WHERE id = $1', [id]);
        const existing = existingRows[0];
        if (!existing) {
          const err = new Error('not_found');
          err.httpStatus = 404;
          throw err;
        }
        const ticketColumn = TICKET_COLUMN[existing.field];

        if (body.set_default === true) {
          await client.query(
            'UPDATE ticket_field_options SET is_default = false WHERE field = $1 AND is_default = true',
            [existing.field]
          );
          await client.query('UPDATE ticket_field_options SET is_default = true WHERE id = $1', [id]);
        }

        if (body.move === 'up' || body.move === 'down') {
          const { rows: neighborRows } = await client.query(
            body.move === 'up'
              ? 'SELECT * FROM ticket_field_options WHERE field = $1 AND sort_order < $2 ORDER BY sort_order DESC LIMIT 1'
              : 'SELECT * FROM ticket_field_options WHERE field = $1 AND sort_order > $2 ORDER BY sort_order ASC LIMIT 1',
            [existing.field, existing.sort_order]
          );
          const neighbor = neighborRows[0];
          if (neighbor) {
            await client.query('UPDATE ticket_field_options SET sort_order = $1 WHERE id = $2', [neighbor.sort_order, existing.id]);
            await client.query('UPDATE ticket_field_options SET sort_order = $1 WHERE id = $2', [existing.sort_order, neighbor.id]);
          }
        }

        if (typeof body.label === 'string' && body.label.trim() && body.label.trim() !== existing.label) {
          const newLabel = body.label.trim();
          await client.query('UPDATE ticket_field_options SET label = $1 WHERE id = $2', [newLabel, id]);
          await client.query(`UPDATE tickets SET ${ticketColumn} = $1 WHERE ${ticketColumn} = $2`, [newLabel, existing.label]);
        }

        const { rows } = await client.query('SELECT * FROM ticket_field_options WHERE id = $1', [id]);
        return rows[0];
      });
      sendJson(res, 200, { option });
    } catch (err) {
      if (err.httpStatus) {
        sendJson(res, err.httpStatus, { error: err.message });
        return;
      }
      if (err.code === '23505') {
        sendJson(res, 409, { error: 'already_exists' });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'DELETE') {
    try {
      await withTenant(tenant.id, async (client) => {
        const { rows: existingRows } = await client.query('SELECT * FROM ticket_field_options WHERE id = $1', [id]);
        const existing = existingRows[0];
        if (!existing) {
          const err = new Error('not_found');
          err.httpStatus = 404;
          throw err;
        }
        if (existing.is_default) {
          const err = new Error('cannot_delete_default');
          err.httpStatus = 400;
          throw err;
        }
        const ticketColumn = TICKET_COLUMN[existing.field];
        const { rows: usageRows } = await client.query(
          `SELECT COUNT(*)::int AS count FROM tickets WHERE ${ticketColumn} = $1`,
          [existing.label]
        );
        if (usageRows[0].count > 0) {
          const err = new Error('in_use');
          err.httpStatus = 409;
          err.count = usageRows[0].count;
          throw err;
        }
        await client.query('DELETE FROM ticket_field_options WHERE id = $1', [id]);
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err.httpStatus) {
        sendJson(res, err.httpStatus, { error: err.message, count: err.count });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
});
