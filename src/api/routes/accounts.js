const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db');
const { createAlert } = require('../../lib/jobs');
const {
  isSafeCpanelUser,
  isSafeDomain,
  normalizeCpanelUser,
  normalizeDomain,
  normalizeServerSlug
} = require('../../lib/security');
const {
  adminMiddleware,
  authMiddleware,
  requireAccountAccess,
  userMiddleware
} = require('../../middleware/auth');

const router = express.Router();

function findDefaultServer(db, requestedSlug) {
  if (requestedSlug) {
    return db.prepare('SELECT * FROM servers WHERE slug = ?').get(requestedSlug);
  }

  return db.prepare('SELECT * FROM servers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1').get();
}

function findAccountByCpanelUser(db, cpanelUser) {
  return db.prepare(`
    SELECT
      a.*,
      srv.slug AS server_slug,
      srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.cpanel_user = ?
    ORDER BY a.created_at DESC
    LIMIT 1
  `).get(cpanelUser);
}

function findAccountById(db, accountId) {
  return db.prepare(`
    SELECT
      a.*,
      srv.slug AS server_slug,
      srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    WHERE a.id = ?
  `).get(accountId);
}

function buildAccountStatus(db, account) {
  const lastBackup = db.prepare(`
    SELECT * FROM backups
    WHERE account_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(account.id);

  const totalBackups = db.prepare(`
    SELECT COUNT(*) AS count FROM backups WHERE account_id = ?
  `).get(account.id);

  const queuedJobs = db.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    WHERE account_id = ? AND status IN ('queued', 'running')
  `).get(account.id);

  return {
    account,
    lastBackup,
    totalBackups: totalBackups.count,
    queuedJobs: queuedJobs.count
  };
}

function createOrUpdateAccount(req, res) {
  const db = getDb();
  const cpanelUser = normalizeCpanelUser(req.body?.cpanel_user);
  const domain = normalizeDomain(req.body?.domain);
  const plan = String(req.body?.plan || 'basic').trim();
  const requestedServerSlug = normalizeServerSlug(req.body?.server_slug || '');

  if (!isSafeCpanelUser(cpanelUser) || !isSafeDomain(domain)) {
    return res.status(400).json({ error: 'cpanel_user and domain are required' });
  }

  const server = findDefaultServer(db, requestedServerSlug || null);

  if (!server) {
    return res.status(400).json({ error: 'No cPanel server configured' });
  }

  const existing = db.prepare(`
    SELECT * FROM accounts
    WHERE server_id = ? AND cpanel_user = ?
  `).get(server.id, cpanelUser);

  if (existing) {
    return res.status(409).json({ error: 'Account already exists' });
  }

  const id = uuidv4();
  const storagePath = `/${server.slug}/${cpanelUser}`;

  db.prepare(`
    INSERT INTO accounts (
      id, server_id, cpanel_user, domain, plan, status, storage_path, auto_backup_enabled
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0)
  `).run(id, server.id, cpanelUser, domain, plan, storagePath);

  createAlert({
    accountId: id,
    title: 'Account activated',
    message: `Account ${cpanelUser} is now active on ${server.name}.`,
    level: 'info'
  });

  return res.json({
    success: true,
    account: {
      id,
      cpanel_user: cpanelUser,
      domain,
      plan,
      storage_path: storagePath,
      server_slug: server.slug,
      server_name: server.name
    }
  });
}

router.post('/activate', adminMiddleware, createOrUpdateAccount);
router.post('/', adminMiddleware, createOrUpdateAccount);

router.get('/me/status', userMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountById(db, req.user.account_id);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json(buildAccountStatus(db, account));
});

router.get('/:cpanel_user/status', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  return res.json(buildAccountStatus(db, account));
});

router.get('/', adminMiddleware, (req, res) => {
  const db = getDb();
  const accounts = db.prepare(`
    SELECT
      a.*,
      srv.slug AS server_slug,
      srv.name AS server_name
    FROM accounts a
    JOIN servers srv ON srv.id = a.server_id
    ORDER BY a.created_at DESC
  `).all();

  const result = accounts.map((account) => {
    const backups = db.prepare('SELECT COUNT(*) AS count FROM backups WHERE account_id = ?').get(account.id);
    const activeJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE account_id = ? AND status IN ('queued', 'running')
    `).get(account.id);

    return {
      ...account,
      totalBackups: backups.count,
      activeJobs: activeJobs.count
    };
  });

  return res.json(result);
});

module.exports = router;
