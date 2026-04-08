const express = require('express');
const { getDb } = require('../../db');
const { adminMiddleware, authMiddleware, requireAccountAccess } = require('../../middleware/auth');

const router = express.Router();

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

router.get('/stats/overview', adminMiddleware, (req, res) => {
  const db = getDb();
  const totalServers = db.prepare('SELECT COUNT(*) AS count FROM servers').get();
  const enabledServers = db.prepare('SELECT COUNT(*) AS count FROM servers WHERE enabled = 1').get();
  const totalAccounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get();
  const totalBackups = db.prepare('SELECT COUNT(*) AS count FROM backups').get();
  const totalJobs = db.prepare('SELECT COUNT(*) AS count FROM jobs').get();
  const runningJobs = db.prepare(`
    SELECT COUNT(*) AS count
    FROM jobs
    WHERE status IN ('queued', 'running')
  `).get();
  const unreadAlerts = db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE read = 0").get();
  const recentAlerts = db.prepare(`
    SELECT
      al.*,
      a.cpanel_user
    FROM alerts al
    LEFT JOIN accounts a ON a.id = al.account_id
    ORDER BY al.created_at DESC
    LIMIT 5
  `).all();

  return res.json({
    totalServers: totalServers.count,
    enabledServers: enabledServers.count,
    totalAccounts: totalAccounts.count,
    totalBackups: totalBackups.count,
    totalJobs: totalJobs.count,
    runningJobs: runningJobs.count,
    unreadAlerts: unreadAlerts.count,
    recentAlerts
  });
});

router.get('/alerts/all', adminMiddleware, (req, res) => {
  const db = getDb();
  const alerts = db.prepare(`
    SELECT
      al.*,
      a.cpanel_user,
      a.domain
    FROM alerts al
    LEFT JOIN accounts a ON a.id = al.account_id
    ORDER BY al.created_at DESC
    LIMIT 100
  `).all();

  return res.json(alerts);
});

router.get('/alerts/me', authMiddleware, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'User session required' });
  }

  const db = getDb();
  const alerts = db.prepare(`
    SELECT *
    FROM alerts
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).all(req.user.account_id);

  return res.json(alerts);
});

router.post('/alerts/me/read-all', authMiddleware, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'User session required' });
  }

  const db = getDb();
  db.prepare('UPDATE alerts SET read = 1 WHERE account_id = ?').run(req.user.account_id);
  return res.json({ success: true });
});

router.get('/me', authMiddleware, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'User session required' });
  }

  const db = getDb();
  const jobs = db.prepare(`
    SELECT *
    FROM jobs
    WHERE account_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.user.account_id);

  return res.json(jobs);
});

router.get('/', adminMiddleware, (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT
      j.*,
      a.cpanel_user,
      a.domain,
      srv.slug AS server_slug
    FROM jobs j
    JOIN accounts a ON a.id = j.account_id
    JOIN servers srv ON srv.id = a.server_id
    ORDER BY j.created_at DESC
    LIMIT 100
  `).all();

  return res.json(jobs);
});

router.get('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const jobs = db.prepare(`
    SELECT *
    FROM jobs
    WHERE account_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(account.id);

  return res.json(jobs);
});

router.get('/alerts/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const alerts = db.prepare(`
    SELECT *
    FROM alerts
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).all(account.id);

  return res.json(alerts);
});

module.exports = router;
