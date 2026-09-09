// Wrapper commun pour les routes API : résout le tenant, capture les erreurs,
// renvoie du JSON de façon homogène. Chaque endpoint reçoit (req, res, tenant).

const { resolveTenantFromRequest } = require('./tenant');

function withTenantHandler(fn) {
  return async function handler(req, res) {
    let tenant;
    try {
      tenant = await resolveTenantFromRequest(req);
    } catch (err) {
      console.error('Erreur résolution tenant', err);
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    if (!tenant) {
      res.status(400).json({ error: 'tenant_not_resolved', message: 'X-Shop-Domain ou X-Tenant-Slug requis et reconnu' });
      return;
    }
    try {
      await fn(req, res, tenant);
    } catch (err) {
      console.error(`Erreur dans ${req.url}`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    }
  };
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

module.exports = { withTenantHandler, sendJson };
