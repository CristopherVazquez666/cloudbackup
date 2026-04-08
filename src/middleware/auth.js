const { getDb } = require('../db');
const { safeCompare } = require('../lib/security');
const { clearSession, issueSession, readSession } = require('../lib/sessions');

function optionalAuthMiddleware(req, res, next) {
  const session = readSession(req);

  if (session) {
    req.session = session;
    req.user = {
      role: session.role,
      username: session.username || null,
      account_id: session.accountId || null,
      cpanel_user: session.cpanelUser || null
    };
  }

  next();
}

function authMiddleware(req, res, next) {
  optionalAuthMiddleware(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    next();
  });
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    next();
  });
}

function userMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'user') {
      return res.status(403).json({ error: 'User session required' });
    }

    next();
  });
}

function agentMiddleware(req, res, next) {
  const serverSlug = String(req.headers['x-bovedix-server-slug'] || '').trim().toLowerCase();
  const sharedSecret = String(req.headers['x-bovedix-shared-secret'] || '').trim();

  if (!serverSlug || !sharedSecret) {
    return res.status(401).json({ error: 'Agent credentials required' });
  }

  const db = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE slug = ? AND enabled = 1').get(serverSlug);

  if (!server || !safeCompare(sharedSecret, server.shared_secret)) {
    return res.status(401).json({ error: 'Invalid agent credentials' });
  }

  req.agent = {
    id: server.id,
    slug: server.slug,
    name: server.name
  };

  next();
}

function requireAccountAccess(req, res, account) {
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return false;
  }

  if (req.user?.role === 'admin') {
    return true;
  }

  if (req.user?.role === 'user' && req.user.account_id === account.id) {
    return true;
  }

  res.status(403).json({ error: 'Forbidden' });
  return false;
}

module.exports = {
  adminMiddleware,
  agentMiddleware,
  authMiddleware,
  clearSession,
  issueSession,
  optionalAuthMiddleware,
  requireAccountAccess,
  userMiddleware
};
