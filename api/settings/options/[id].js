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
        // Correctif sécurité 2026-09-14 : filtre tenant_id ajouté sur TOUTES
        // les requêtes ci-dessous. Sans lui, ce fichier n'avait reçu AUCUN
        // des correctifs appliqués ailleurs (12/09 puis 14/09) alors qu'il
        // manipule la même table que api/settings/options/index.js : un id
        // d'option de l'AUTRE marque pouvait être lu/modifié, et surtout le
        // renommage de label plus bas (UPDATE tickets SET category = ...)
        // pouvait renommer une catégorie chez les DEUX marques à la fois si
        // les libellés coïncidaient (RLS ne protège pas ces requêtes, rôle
        // applicatif en BYPASSRLS).
        const { rows: existingRows } = await client.query(
          'SELECT * FROM ticket_field_options WHERE id = $1 AND tenant_id = $2',
          [id, tenant.id]
        );
        const existing = existingRows[0];
        if (!existing) {
          const err = new Error('not_found');
          err.httpStatus = 404;
          throw err;
        }
        const ticketColumn = TICKET_COLUMN[existing.field];

        if (body.set_default === true) {
          await client.query(
            'UPDATE ticket_field_options SET is_default = false WHERE tenant_id = $1 AND field = $2 AND is_default = true',
            [tenant.id, existing.field]
          );
          await client.query('UPDATE ticket_field_options SET is_default = true WHERE id = $1 AND tenant_id = $2', [id, tenant.id]);
        }

        if (body.move === 'up' || body.move === 'down') {
          const { rows: neighborRows } = await client.query(
            body.move === 'up'
              ? 'SELECT * FROM ticket_field_options WHERE tenant_id = $1 AND field = $2 AND sort_order < $3 ORDER BY sort_order DESC LIMIT 1'
              : 'SELECT * FROM ticket_field_options WHERE tenant_id = $1 AND field = $2 AND sort_order > $3 ORDER BY sort_order ASC LIMIT 1',
            [tenant.id, existing.field, existing.sort_order]
          );
          const neighbor = neighborRows[0];
          if (neighbor) {
            await client.query('UPDATE ticket_field_options SET sort_order = $1 WHERE id = $2 AND tenant_id = $3', [neighbor.sort_order, existing.id, tenant.id]);
            await client.query('UPDATE ticket_field_options SET sort_order = $1 WHERE id = $2 AND tenant_id = $3', [existing.sort_order, neighbor.id, tenant.id]);
          }
        }

        if (typeof body.label === 'string' && body.label.trim() && body.label.trim() !== existing.label) {
          const newLabel = body.label.trim();
          await client.query('UPDATE ticket_field_options SET label = $1 WHERE id = $2 AND tenant_id = $3', [newLabel, id, tenant.id]);
          await client.query(`UPDATE tickets SET ${ticketColumn} = $1 WHERE ${ticketColumn} = $2 AND tenant_id = $3`, [newLabel, existing.label, tenant.id]);
        }

        const { rows } = await client.query('SELECT * FROM ticket_field_options WHERE id = $1 AND tenant_id = $2', [id, tenant.id]);
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
        // Même correctif que ci-dessus : tenant_id ajouté sur les trois
        // requêtes de la suppression.
        const { rows: existingRows } = await client.query('SELECT * FROM ticket_field_options WHERE id = $1 AND tenant_id = $2', [id, tenant.id]);
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
          `SELECT COUNT(*)::int AS count FROM tickets WHERE ${ticketColumn} = $1 AND tenant_id = $2`,
          [existing.label, tenant.id]
        );
        if (usageRows[0].count > 0) {
          const err = new Error('in_use');
          err.httpStatus = 409;
          err.count = usageRows[0].count;
          throw err;
        }
        await client.query('DELETE FROM ticket_field_options WHERE id = $1 AND tenant_id = $2', [id, tenant.id]);
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
