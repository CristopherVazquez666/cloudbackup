const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db');
const { createAlert } = require('../../lib/jobs');
const { agentMiddleware } = require('../../middleware/auth');

const router = express.Router();

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

router.get('/status', agentMiddleware, (req, res) => {
  return res.json({
    success: true,
    server: req.agent
  });
});

router.get('/jobs/next', agentMiddleware, (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT
      j.*,
      a.cpanel_user,
      a.domain,
      a.storage_path
    FROM jobs j
    JOIN accounts a ON a.id = j.account_id
    WHERE a.server_id = ?
      AND j.status = 'queued'
    ORDER BY j.created_at ASC
    LIMIT 1
  `).get(req.agent.id);

  if (!job) {
    return res.json({ job: null });
  }

  return res.json({
    job: {
      ...job,
      payload: parseJson(job.payload)
    }
  });
});

router.post('/jobs/:job_id/start', agentMiddleware, (req, res) => {
  const db = getDb();
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'running',
        assigned_server_id = ?,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'queued'
  `).run(req.agent.id, req.params.job_id);

  if (!result.changes) {
    return res.status(409).json({ error: 'Job is not available to start' });
  }

  return res.json({ success: true });
});

router.post('/jobs/:job_id/complete', agentMiddleware, (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT
      j.*,
      a.cpanel_user,
      a.domain
    FROM jobs j
    JOIN accounts a ON a.id = j.account_id
    WHERE j.id = ?
      AND a.server_id = ?
  `).get(req.params.job_id, req.agent.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const resultPayload = req.body?.result || {};
  const logMessage = String(req.body?.log || 'Completed by agent').trim();

  db.prepare(`
    UPDATE jobs
    SET status = 'completed',
        result = ?,
        log = ?,
        ended_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(resultPayload), logMessage, job.id);

  if (job.type === 'backup' && req.body?.backup) {
    const backup = req.body.backup;
    db.prepare(`
      INSERT INTO backups (
        id, account_id, filename, filesize, kind, status,
        remote_path, checksum, source_job_id, notes
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
    `).run(
      uuidv4(),
      job.account_id,
      backup.filename,
      Number(backup.filesize || 0),
      backup.kind || 'full',
      backup.remote_path || null,
      backup.checksum || null,
      job.id,
      backup.notes || null
    );
  }

  createAlert({
    accountId: job.account_id,
    title: `${job.type} completed`,
    message: `${job.type} completed for ${job.cpanel_user}.`,
    level: 'info'
  });

  return res.json({ success: true });
});

router.post('/jobs/:job_id/fail', agentMiddleware, (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT
      j.*,
      a.cpanel_user
    FROM jobs j
    JOIN accounts a ON a.id = j.account_id
    WHERE j.id = ?
      AND a.server_id = ?
  `).get(req.params.job_id, req.agent.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const logMessage = String(req.body?.log || req.body?.error || 'Job failed').trim();

  db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        log = ?,
        ended_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(logMessage, job.id);

  createAlert({
    accountId: job.account_id,
    title: `${job.type} failed`,
    message: `${job.type} failed for ${job.cpanel_user}: ${logMessage}`,
    level: 'warning'
  });

  return res.json({ success: true });
});

module.exports = router;
