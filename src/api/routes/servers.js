const express = require('express');
const { getDb } = require('../../db');
const { adminMiddleware } = require('../../middleware/auth');

const router = express.Router();

router.get('/', adminMiddleware, (req, res) => {
  const db = getDb();
  const servers = db.prepare(`
    SELECT *
    FROM servers
    ORDER BY enabled DESC, name ASC, created_at ASC
  `).all();

  const result = servers.map((server) => {
    const accounts = db.prepare(`
      SELECT COUNT(*) AS count
      FROM accounts
      WHERE server_id = ?
    `).get(server.id);

    const backups = db.prepare(`
      SELECT COUNT(*) AS count
      FROM backups b
      JOIN accounts a ON a.id = b.account_id
      WHERE a.server_id = ?
    `).get(server.id);

    const queuedJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs j
      JOIN accounts a ON a.id = j.account_id
      WHERE a.server_id = ? AND j.status IN ('queued', 'running')
    `).get(server.id);

    const latestJob = db.prepare(`
      SELECT MAX(j.created_at) AS latest_job_at
      FROM jobs j
      JOIN accounts a ON a.id = j.account_id
      WHERE a.server_id = ?
    `).get(server.id);

    return {
      ...server,
      account_count: accounts.count,
      backup_count: backups.count,
      queued_jobs: queuedJobs.count,
      latest_job_at: latestJob.latest_job_at || null,
      telemetry_status: latestJob.latest_job_at ? 'agent-ready' : 'pending-sync',
      shared_secret_configured: Boolean(server.shared_secret)
    };
  });

  return res.json(result);
});

module.exports = router;
