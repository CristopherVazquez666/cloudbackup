const express = require('express');
const { getDb } = require('../../db');
const { createAlert, enqueueJob } = require('../../lib/jobs');
const {
  adminMiddleware,
  authMiddleware,
  requireAccountAccess
} = require('../../middleware/auth');

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

function findBackupById(db, backupId) {
  return db.prepare(`
    SELECT
      b.*,
      a.cpanel_user,
      a.domain,
      a.id AS account_id
    FROM backups b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ?
  `).get(backupId);
}

function queueBackupForAccount(db, account, actor) {
  const job = enqueueJob({
    accountId: account.id,
    type: 'backup',
    requestedByRole: actor.role,
    requestedBy: actor.username || actor.cpanel_user || account.cpanel_user,
    assignedServerId: account.server_id,
    payload: {
      backup_kind: 'full',
      cpanel_user: account.cpanel_user,
      domain: account.domain,
      storage_path: account.storage_path
    }
  });

  createAlert({
    accountId: account.id,
    title: 'Backup queued',
    message: `Backup request queued for ${account.cpanel_user}.`,
    level: 'info'
  });

  return job;
}

function queueActionJob(db, account, backup, type, actor) {
  const job = enqueueJob({
    accountId: account.id,
    type,
    requestedByRole: actor.role,
    requestedBy: actor.username || actor.cpanel_user || account.cpanel_user,
    assignedServerId: account.server_id,
    payload: {
      backup_id: backup.id,
      filename: backup.filename,
      remote_path: backup.remote_path
    }
  });

  createAlert({
    accountId: account.id,
    title: type === 'restore' ? 'Restore queued' : 'Download queued',
    message: `${type === 'restore' ? 'Restore' : 'Download'} queued for ${backup.filename}.`,
    level: 'info'
  });

  return job;
}

router.get('/admin/all', adminMiddleware, (req, res) => {
  const db = getDb();
  const backups = db.prepare(`
    SELECT
      b.*,
      a.cpanel_user,
      a.domain,
      srv.slug AS server_slug
    FROM backups b
    JOIN accounts a ON a.id = b.account_id
    JOIN servers srv ON srv.id = a.server_id
    ORDER BY b.created_at DESC
    LIMIT 200
  `).all();

  return res.json(backups);
});

router.post('/request', authMiddleware, (req, res) => {
  const db = getDb();
  const accountId = req.user.role === 'admin'
    ? String(req.body?.account_id || '').trim()
    : req.user.account_id;
  const account = findAccountById(db, accountId);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const job = queueBackupForAccount(db, account, req.user);
  return res.json({ success: true, jobId: job.id, status: job.status });
});

router.post('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const job = queueBackupForAccount(db, account, req.user);
  return res.json({ success: true, jobId: job.id, status: job.status });
});

router.get('/me', authMiddleware, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'User session required' });
  }

  const db = getDb();
  const backups = db.prepare(`
    SELECT *
    FROM backups
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).all(req.user.account_id);

  return res.json(backups);
});

router.get('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const backups = db.prepare(`
    SELECT *
    FROM backups
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).all(account.id);

  return res.json(backups);
});

router.post('/:backup_id/restore', authMiddleware, (req, res) => {
  const db = getDb();
  const backup = findBackupById(db, req.params.backup_id);
  const account = backup ? findAccountById(db, backup.account_id) : null;

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const job = queueActionJob(db, account, backup, 'restore', req.user);
  return res.json({ success: true, jobId: job.id, status: job.status });
});

router.post('/:backup_id/download', authMiddleware, (req, res) => {
  const db = getDb();
  const backup = findBackupById(db, req.params.backup_id);
  const account = backup ? findAccountById(db, backup.account_id) : null;

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const job = queueActionJob(db, account, backup, 'download', req.user);
  return res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    remote_path: backup.remote_path
  });
});

module.exports = router;
