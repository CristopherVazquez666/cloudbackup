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
const { adminMiddleware, issueSession, clearSession, optionalAuthMiddleware } = require('../../middleware/auth');

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

function findAccountForAdminPreview(db, cpanelUser, serverSlug = '') {
  if (serverSlug) {
    return db.prepare(`
      SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
      FROM accounts a
      JOIN servers srv ON srv.id = a.server_id
      WHERE a.cpanel_user = ?
        AND srv.slug = ?
      LIMIT 1
    `).get(cpanelUser, serverSlug);
  }

  return db.prepare(`
    SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.cpanel_user = ?
    ORDER BY a.created_at DESC
    LIMIT 1
  `).get(cpanelUser);
}

function isDevUserPreviewEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_ALLOW_DIRECT_USER_PREVIEW === 'true';
}

function getDevPreviewFixtures() {
  const gib = 1024 ** 3;

  return {
    basic: {
      cpanelUser: 'demo-basic',
      domain: 'basic.demo.localhost',
      plan: 'basic',
      backups: [
        { filename: 'basic-weekly-full.tar.zst', filesize: 18 * gib, createdAt: '2026-04-07T09:30:00Z' },
        { filename: 'basic-daily-full.tar.zst', filesize: 14 * gib, createdAt: '2026-04-08T09:30:00Z' }
      ]
    },
    pro: {
      cpanelUser: 'demo-pro',
      domain: 'pro.demo.localhost',
      plan: 'pro',
      backups: [
        { filename: 'pro-weekly-full.tar.zst', filesize: 72 * gib, createdAt: '2026-04-06T08:15:00Z' },
        { filename: 'pro-midweek-full.tar.zst', filesize: 58 * gib, createdAt: '2026-04-07T08:15:00Z' },
        { filename: 'pro-daily-full.tar.zst', filesize: 46 * gib, createdAt: '2026-04-08T08:15:00Z' }
      ]
    },
    business: {
      cpanelUser: 'demo-business',
      domain: 'business.demo.localhost',
      plan: 'business',
      backups: [
        { filename: 'business-weekly-full.tar.zst', filesize: 126 * gib, createdAt: '2026-04-05T11:20:00Z' },
        { filename: 'business-midweek-full.tar.zst', filesize: 104 * gib, createdAt: '2026-04-07T11:20:00Z' },
        { filename: 'business-daily-full.tar.zst', filesize: 88 * gib, createdAt: '2026-04-08T11:20:00Z' }
      ]
    },
    enterprise: {
      cpanelUser: 'demo-enterprise',
      domain: 'enterprise.demo.localhost',
      plan: 'enterprise',
      backups: [
        { filename: 'enterprise-weekly-full.tar.zst', filesize: 248 * gib, createdAt: '2026-04-04T13:45:00Z' },
        { filename: 'enterprise-midweek-full.tar.zst', filesize: 220 * gib, createdAt: '2026-04-06T13:45:00Z' },
        { filename: 'enterprise-daily-full.tar.zst', filesize: 184 * gib, createdAt: '2026-04-08T13:45:00Z' }
      ]
    }
  };
}

function ensureDevPreviewAccount(db, requestedPlan = 'basic') {
  const fixtures = getDevPreviewFixtures();
  const fixture = fixtures[requestedPlan] || fixtures.basic;

  const server = db.prepare(`
    SELECT *
    FROM servers
    WHERE enabled = 1
    ORDER BY created_at ASC
    LIMIT 1
  `).get();

  if (!server) {
    return null;
  }

  const existing = db.prepare(`
    SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.server_id = ? AND a.cpanel_user = ?
    LIMIT 1
  `).get(server.id, fixture.cpanelUser);

  let accountId = existing?.id || uuidv4();
  const storagePath = `/${server.slug}/${fixture.cpanelUser}`;

  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET domain = ?, plan = ?, status = 'active', storage_path = ?, auto_backup_enabled = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixture.domain, fixture.plan, storagePath, existing.id);
  } else {
    db.prepare(`
      INSERT INTO accounts (
        id, server_id, cpanel_user, domain, plan, status, storage_path, auto_backup_enabled
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0)
    `).run(accountId, server.id, fixture.cpanelUser, fixture.domain, fixture.plan, storagePath);
  }

  db.prepare(`DELETE FROM backups WHERE account_id = ?`).run(accountId);

  const insertBackup = db.prepare(`
    INSERT INTO backups (
      id, account_id, filename, filesize, kind, status, remote_path, checksum, created_at
    ) VALUES (?, ?, ?, ?, 'full', 'ready', ?, ?, ?)
  `);

  fixture.backups.forEach((backup, index) => {
    insertBackup.run(
      uuidv4(),
      accountId,
      backup.filename,
      backup.filesize,
      `${storagePath}/${backup.filename}`,
      `dev-preview-${fixture.plan}-${index + 1}`,
      backup.createdAt
    );
  });

  return db.prepare(`
    SELECT a.*, srv.slug AS server_slug, srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.id = ?
  `).get(accountId);
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

router.get('/dev/user-preview', (req, res) => {
  if (!isDevUserPreviewEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }

  const db = getDb();
  const requestedPlan = String(req.query.plan || 'basic').trim().toLowerCase();
  const account = ensureDevPreviewAccount(db, requestedPlan);

  if (!account) {
    return res.status(500).json({ error: 'No enabled server is available for local preview' });
  }

  issueSession(res, {
    role: 'user',
    accountId: account.id,
    cpanelUser: account.cpanel_user,
    metadata: {
      server_slug: account.server_slug,
      preview_domain: account.domain,
      source: 'local-dev-preview'
    }
  });

  return res.redirect('/user/');
});

router.get('/admin/preview-user/:cpanel_user', adminMiddleware, (req, res) => {
  const db = getDb();
  const cpanelUser = normalizeCpanelUser(req.params.cpanel_user);
  const serverSlug = normalizeServerSlug(req.query.server_slug || '');

  if (!isSafeCpanelUser(cpanelUser) || (serverSlug && !isSafeServerSlug(serverSlug))) {
    return res.status(400).json({ error: 'Invalid preview target' });
  }

  const account = findAccountForAdminPreview(db, cpanelUser, serverSlug);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  if (account.status !== 'active') {
    return res.status(403).json({ error: 'Account is not active' });
  }

  issueSession(res, {
    role: 'user',
    accountId: account.id,
    cpanelUser: account.cpanel_user,
    metadata: {
      server_slug: account.server_slug,
      source: 'admin-preview'
    }
  });

  return res.redirect('/user/');
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
