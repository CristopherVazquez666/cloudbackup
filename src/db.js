const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(__dirname, '../data/bovedix.db');

let db;

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      cpanel_host TEXT,
      shared_secret TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      cpanel_user TEXT NOT NULL,
      domain TEXT NOT NULL,
      plan TEXT DEFAULT 'basic',
      status TEXT DEFAULT 'active',
      storage_path TEXT,
      auto_backup_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(server_id, cpanel_user),
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      username TEXT,
      account_id TEXT,
      cpanel_user TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS sso_nonces (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      nonce TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      filesize INTEGER DEFAULT 0,
      kind TEXT DEFAULT 'full',
      status TEXT DEFAULT 'ready',
      remote_path TEXT,
      checksum TEXT,
      source_job_id TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (source_job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      requested_by_role TEXT NOT NULL,
      requested_by TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      payload TEXT,
      result TEXT,
      log TEXT,
      assigned_server_id TEXT,
      started_at DATETIME,
      ended_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (assigned_server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      title TEXT NOT NULL,
      message TEXT,
      level TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_server_user ON accounts(server_id, cpanel_user);
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_account_created ON jobs(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_backups_account_created ON backups(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_account_created ON alerts(account_id, created_at DESC);
  `);
}

function seedDefaults() {
  const slug = (process.env.DEFAULT_SERVER_SLUG || 'default-cpanel').trim().toLowerCase();
  const name = (process.env.DEFAULT_SERVER_NAME || 'Default cPanel Server').trim();
  const host = (process.env.CPANEL_HOST || '').trim() || null;
  const sharedSecret = (process.env.PLUGIN_SHARED_SECRET || '').trim();

  if (!sharedSecret) {
    return;
  }

  const existing = db.prepare('SELECT id FROM servers WHERE slug = ?').get(slug);

  if (existing) {
    db.prepare(`
      UPDATE servers
      SET name = ?, cpanel_host = ?, shared_secret = ?, enabled = 1
      WHERE id = ?
    `).run(name, host, sharedSecret, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO servers (id, slug, name, cpanel_host, shared_secret, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(uuidv4(), slug, name, host, sharedSecret);
}

function purgeExpiredRecords() {
  db.prepare(`
    DELETE FROM sessions
    WHERE revoked_at IS NOT NULL
       OR replace(substr(expires_at, 1, 19), 'T', ' ') <= CURRENT_TIMESTAMP
  `).run();

  db.prepare(`
    DELETE FROM sso_nonces
    WHERE replace(substr(expires_at, 1, 19), 'T', ' ') <= CURRENT_TIMESTAMP
  `).run();
}

function getDb() {
  if (!db) {
    ensureParentDir(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    seedDefaults();
    purgeExpiredRecords();
  }

  return db;
}

module.exports = { getDb, DB_PATH };
