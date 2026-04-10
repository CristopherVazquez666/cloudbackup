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
  const requestedKind = String(actor.backup_kind || 'full').trim().toLowerCase();
  const backupKind = ['db', 'mail', 'full'].includes(requestedKind) ? requestedKind : 'full';
  const databaseName = backupKind === 'db'
    ? String(actor.database_name || '').trim() || null
    : null;
  const job = enqueueJob({
    accountId: account.id,
    type: 'backup',
    requestedByRole: actor.role,
    requestedBy: actor.username || actor.cpanel_user || account.cpanel_user,
    assignedServerId: account.server_id,
    payload: {
      backup_kind: backupKind,
      cpanel_user: account.cpanel_user,
      domain: account.domain,
      storage_path: account.storage_path,
      ...(databaseName ? { database_name: databaseName } : {})
    }
  });

  createAlert({
    accountId: account.id,
    title: backupKind === 'db'
      ? 'Database backup queued'
      : backupKind === 'mail'
        ? 'Mail backup queued'
        : 'Backup queued',
    message: backupKind === 'db'
      ? `Database backup request queued for ${account.cpanel_user}${databaseName ? ` (${databaseName})` : ''}.`
      : backupKind === 'mail'
        ? `Mail backup request queued for ${account.cpanel_user}.`
        : `Backup request queued for ${account.cpanel_user}.`,
    level: 'info'
  });

  return job;
}

function queueActionJob(db, account, backup, type, actor) {
  const backupKind = String(backup.kind || 'full').trim().toLowerCase();
  const databaseName = backupKind === 'db' && String(backup.filename || '').endsWith('.sql.gz')
    ? String(backup.filename).slice(0, -'.sql.gz'.length)
    : null;
  const job = enqueueJob({
    accountId: account.id,
    type,
    requestedByRole: actor.role,
    requestedBy: actor.username || actor.cpanel_user || account.cpanel_user,
    assignedServerId: account.server_id,
    payload: {
      backup_id: backup.id,
      backup_kind: backupKind,
      ...(databaseName ? { database_name: databaseName } : {}),
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

  const job = queueBackupForAccount(db, account, {
    ...req.user,
    backup_kind: req.body?.backup_kind,
    database_name: req.body?.database_name
  });
  return res.json({ success: true, jobId: job.id, status: job.status });
});

router.post('/:cpanel_user', authMiddleware, (req, res) => {
  const db = getDb();
  const account = findAccountByCpanelUser(db, req.params.cpanel_user);

  if (!requireAccountAccess(req, res, account)) {
    return;
  }

  const job = queueBackupForAccount(db, account, {
    ...req.user,
    backup_kind: req.body?.backup_kind,
    database_name: req.body?.database_name
  });
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
