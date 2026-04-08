const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db');
const {
  isSafeCpanelUser,
  isSafeDomain,
  isSafeServerSlug,
  normalizeCpanelUser,
  normalizeDomain,
  normalizeServerSlug,
  safeCompare,
  signSsoPayload
} = require('../../lib/security');
const { issueSession, clearSession, optionalAuthMiddleware } = require('../../middleware/auth');

const router = express.Router();

function serializeSession(req) {
  if (!req.session || !req.user) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    user: {
      role: req.user.role,
      username: req.user.username || null,
      account_id: req.user.account_id || null,
      cpanel_user: req.user.cpanel_user || null,
      account: req.session.account || null
    }
  };
}

function parseSsoTimestamp(rawValue) {
  const numeric = Number(rawValue);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric > 1e12) {
    return numeric;
  }

  return numeric * 1000;
}

function resolveAccountFromSso(db, server, cpanelUser, domain) {
  const existing = db.prepare(`
    SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.server_id = ? AND a.cpanel_user = ?
  `).get(server.id, cpanelUser);

  if (existing) {
    return existing;
  }

  if (process.env.AUTO_PROVISION_FROM_SSO === 'false') {
    return null;
  }

  const id = uuidv4();
  const storagePath = `/${server.slug}/${cpanelUser}`;

  db.prepare(`
    INSERT INTO accounts (
      id, server_id, cpanel_user, domain, plan, status, storage_path, auto_backup_enabled
    ) VALUES (?, ?, ?, ?, 'basic', 'active', ?, 0)
  `).run(id, server.id, cpanelUser, domain, storagePath);

  return db.prepare(`
    SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.id = ?
  `).get(id);
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.ADMIN_USER || '';
  const expectedPass = process.env.ADMIN_PASS || '';

  if (
    safeCompare(String(username || ''), expectedUser) &&
    safeCompare(String(password || ''), expectedPass)
  ) {
    issueSession(res, {
      role: 'admin',
      username
    });

    return res.json({
      success: true,
      role: 'admin',
      username
    });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/logout', optionalAuthMiddleware, (req, res) => {
  clearSession(res, req);
  return res.json({ success: true });
});

router.get('/session', optionalAuthMiddleware, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json(serializeSession(req));
});

router.post('/sso/exchange', (req, res) => {
  const serverSlug = normalizeServerSlug(req.body?.server_slug || req.body?.server);
  const cpanelUser = normalizeCpanelUser(req.body?.cpanel_user);
  const domain = normalizeDomain(req.body?.domain);
  const nonce = String(req.body?.nonce || '').trim();
  const signature = String(req.body?.signature || '').trim();
  const timestamp = String(req.body?.timestamp || '').trim();

  if (
    !isSafeServerSlug(serverSlug) ||
    !isSafeCpanelUser(cpanelUser) ||
    !isSafeDomain(domain) ||
    !nonce ||
    !signature ||
    !timestamp
  ) {
    return res.status(400).json({ error: 'Invalid SSO payload' });
  }

  const timestampMs = parseSsoTimestamp(timestamp);

  if (!timestampMs || Math.abs(Date.now() - timestampMs) > 60 * 1000) {
    return res.status(401).json({ error: 'Expired SSO request' });
  }

  const db = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE slug = ? AND enabled = 1').get(serverSlug);

  if (!server) {
    return res.status(404).json({ error: 'Unknown server' });
  }

  const expectedSignature = signSsoPayload(
    {
      serverSlug,
      cpanelUser,
      domain,
      timestamp,
      nonce
    },
    server.shared_secret
  );

  if (!safeCompare(signature, expectedSignature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const alreadyUsed = db.prepare('SELECT id FROM sso_nonces WHERE nonce = ?').get(nonce);

  if (alreadyUsed) {
    return res.status(409).json({ error: 'Nonce already used' });
  }

  const account = resolveAccountFromSso(db, server, cpanelUser, domain);

  if (!account || account.status !== 'active') {
    return res.status(403).json({ error: 'Account is not active' });
  }

  db.prepare(`
    INSERT INTO sso_nonces (id, server_id, nonce, expires_at, used_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    uuidv4(),
    server.id,
    nonce,
    new Date(timestampMs + 60 * 1000).toISOString()
  );

  issueSession(res, {
    role: 'user',
    accountId: account.id,
    cpanelUser: account.cpanel_user,
    metadata: {
      server_slug: server.slug,
      sso_domain: domain
    }
  });

  return res.json({
    success: true,
    redirect: '/user',
    user: {
      role: 'user',
      account_id: account.id,
      cpanel_user: account.cpanel_user,
      domain: account.domain,
      server_slug: server.slug,
      server_name: server.name
    }
  });
});

module.exports = router;
