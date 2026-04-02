const express = require('express');
const router = express.Router();
const { getDb } = require('../../db');
const { adminMiddleware, authMiddleware } = require('../../../middleware/auth');

// GET /api/jobs — admin
router.get('/', adminMiddleware, (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT j.*, a.cpanel_user, a.domain 
    FROM jobs j JOIN accounts a ON j.account_id = a.id 
    ORDER BY j.created_at DESC LIMIT 50
  `).all();
  return res.json(jobs);
});

// GET /api/jobs/:cpanel_user — user jobs
router.get('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(req.params.cpanel_user);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const jobs = db.prepare('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 20').all(account.id);
  return res.json(jobs);
});

// GET /api/alerts — admin
router.get('/alerts/all', adminMiddleware, (req, res) => {
  const db = getDb();
  const alerts = db.prepare(`
    SELECT al.*, a.cpanel_user 
    FROM alerts al LEFT JOIN accounts a ON al.account_id = a.id 
    ORDER BY al.created_at DESC LIMIT 50
  `).all();
  return res.json(alerts);
});

// GET /api/alerts/:cpanel_user — user alerts
router.get('/alerts/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(req.params.cpanel_user);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const alerts = db.prepare('SELECT * FROM alerts WHERE account_id = ? ORDER BY created_at DESC').all(account.id);
  return res.json(alerts);
});

// GET /api/stats — admin dashboard stats
router.get('/stats/overview', adminMiddleware, (req, res) => {
  const db = getDb();
  const totalAccounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
  const totalBackups = db.prepare('SELECT COUNT(*) as count FROM backups').get();
  const totalJobs = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
  const runningJobs = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status='running'").get();
  const unreadAlerts = db.prepare("SELECT COUNT(*) as count FROM alerts WHERE read=0").get();
  const recentAlerts = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5').all();
  return res.json({
    totalAccounts: totalAccounts.count,
    totalBackups: totalBackups.count,
    totalJobs: totalJobs.count,
    runningJobs: runningJobs.count,
    unreadAlerts: unreadAlerts.count,
    recentAlerts
  });
});

module.exports = router;
