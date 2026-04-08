const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

function createAlert({ accountId = null, title, message = '', level = 'info' }) {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO alerts (id, account_id, title, message, level)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, accountId, title, message, level);

  return id;
}

function enqueueJob({
  accountId,
  type,
  requestedByRole,
  requestedBy = null,
  payload = {},
  assignedServerId = null
}) {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO jobs (
      id, account_id, requested_by_role, requested_by, type,
      status, payload, assigned_server_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    accountId,
    requestedByRole,
    requestedBy,
    type,
    JSON.stringify(payload || {}),
    assignedServerId
  );

  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

module.exports = {
  createAlert,
  enqueueJob
};
