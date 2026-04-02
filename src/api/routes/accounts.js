const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db');
const { adminMiddleware, authMiddleware } = require('../../../middleware/auth');

// POST /api/accounts/activate
router.post('/activate', adminMiddleware, (req, res) => {
  const { cpanel_user, domain, plan } = req.body;
  if (!cpanel_user || !domain) return res.status(400).json({ error: 'cpanel_user and domain required' });
  const db = getDb();
  const existing = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(cpanel_user);
  if (existing) return res.status(409).json({ error: 'Account already exists', account: existing });
  const id = uuidv4();
  const storage_path = `/${cpanel_user}`;
  db.prepare('INSERT INTO accounts (id, cpanel_user, domain, plan, storage_path) VALUES (?, ?, ?, ?, ?)')
    .run(id, cpanel_user, domain, plan || 'basic', storage_path);
  db.prepare("INSERT INTO alerts (id, account_id, title, message, level) VALUES (?, ?, ?, ?, ?)")
    .run(uuidv4(), id, 'Account activated', `Account ${cpanel_user} has been activated successfully`, 'info');
  return res.json({ success: true, account: { id, cpanel_user, domain, plan, storage_path } });
});

// GET /api/accounts/:cpanel_user/status
router.get('/:cpanel_user/status', authMiddleware, (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(req.params.cpanel_user);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const lastBackup = db.prepare('SELECT * FROM backups WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').get(account.id);
  const totalBackups = db.prepare('SELECT COUNT(*) as count FROM backups WHERE account_id = ?').get(account.id);
  return res.json({ account, lastBackup, totalBackups: totalBackups.count });
});

// GET /api/accounts — admin only
router.get('/', adminMiddleware, (req, res) => {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
  const result = accounts.map(a => {
    const backups = db.prepare('SELECT COUNT(*) as count FROM backups WHERE account_id = ?').get(a.id);
    return { ...a, totalBackups: backups.count };
  });
  return res.json(result);
});

module.exports = router;
