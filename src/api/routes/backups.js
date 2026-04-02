const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { execSync, exec } = require('child_process');
const { getDb } = require('../../db');
const { adminMiddleware, authMiddleware } = require('../../../middleware/auth');

// POST /api/backups/:cpanel_user — trigger backup
router.post('/:cpanel_user', adminMiddleware, (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(req.params.cpanel_user);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const jobId = uuidv4();
  db.prepare("INSERT INTO jobs (id, account_id, type, status, started_at) VALUES (?, ?, 'backup', 'running', datetime('now'))")
    .run(jobId, account.id);

  // Run async
  const cpanel_host = process.env.CPANEL_HOST;
  const cpanel_port = process.env.CPANEL_PORT || 22;
  const cpanel_user_ssh = process.env.CPANEL_USER || 'root';
  const storage_host = process.env.STORAGE_HOST;
  const storage_user = process.env.STORAGE_USER;
  const storage_pass = process.env.STORAGE_PASS;
  const cpanel_user = req.params.cpanel_user;

  // Script that runs on cPanel server
  const remoteCmd = `/usr/local/cpanel/scripts/pkgacct ${cpanel_user} /tmp/bovedix-${cpanel_user} && echo "DONE"`;

  exec(
    `ssh -p ${cpanel_port} -o StrictHostKeyChecking=no ${cpanel_user_ssh}@${cpanel_host} "${remoteCmd}"`,
    (err, stdout, stderr) => {
      if (err) {
        db.prepare("UPDATE jobs SET status='failed', log=?, ended_at=datetime('now') WHERE id=?")
          .run(stderr, jobId);
        db.prepare("INSERT INTO alerts (id, account_id, title, message, level) VALUES (?, ?, ?, ?, ?)")
          .run(uuidv4(), account.id, 'Backup failed', `Backup for ${cpanel_user} failed: ${stderr}`, 'warning');
        return;
      }

      // Transfer to storage
      const filename = `cpmove-${cpanel_user}.tar.gz`;
      const remotePath = `${account.storage_path}/${new Date().toISOString().split('T')[0]}/`;
      const scpCmd = `ssh -p ${cpanel_port} -o StrictHostKeyChecking=no ${cpanel_user_ssh}@${cpanel_host} "sshpass -p '${storage_pass}' scp /tmp/bovedix-${cpanel_user}/${filename} ${storage_user}@${storage_host}:${process.env.STORAGE_ROOT}${remotePath}"`;

      exec(scpCmd, (err2) => {
        const backupId = uuidv4();
        const status = err2 ? 'failed' : 'completed';
        if (!err2) {
          db.prepare('INSERT INTO backups (id, account_id, filename, type, status, remote_path) VALUES (?, ?, ?, ?, ?, ?)')
            .run(backupId, account.id, filename, 'full', status, remotePath + filename);
        }
        db.prepare("UPDATE jobs SET status=?, log=?, ended_at=datetime('now') WHERE id=?")
          .run(status, err2 ? err2.message : 'Backup completed successfully', jobId);
        db.prepare("INSERT INTO alerts (id, account_id, title, message, level) VALUES (?, ?, ?, ?, ?)")
          .run(uuidv4(), account.id, `Backup ${status}`, `Backup for ${cpanel_user} ${status}`, status === 'completed' ? 'info' : 'warning');
      });
    }
  );

  return res.json({ success: true, jobId, message: 'Backup started' });
});

// GET /api/backups/:cpanel_user — list backups
router.get('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE cpanel_user = ?').get(req.params.cpanel_user);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const backups = db.prepare('SELECT * FROM backups WHERE account_id = ? ORDER BY created_at DESC').all(account.id);
  return res.json(backups);
});

// GET /api/backups/admin/all — admin: all backups
router.get('/admin/all', adminMiddleware, (req, res) => {
  const db = getDb();
  const backups = db.prepare(`
    SELECT b.*, a.cpanel_user, a.domain 
    FROM backups b JOIN accounts a ON b.account_id = a.id 
    ORDER BY b.created_at DESC LIMIT 100
  `).all();
  return res.json(backups);
});

module.exports = router;
