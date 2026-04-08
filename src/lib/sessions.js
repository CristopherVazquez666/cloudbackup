const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { clearCookie, getCookie, setCookie } = require('./http');

const SESSION_COOKIE = 'bvx_session';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const SESSION_TTL_SECONDS = Math.max(1, SESSION_TTL_HOURS) * 60 * 60;
const JWT_SECRET = process.env.JWT_SECRET || 'bovedix_dev_secret_change_me';

function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_TTL_SECONDS
  };
}

function createSessionRecord(payload) {
  const db = getDb();
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (
      id, role, username, account_id, cpanel_user, metadata, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    payload.role,
    payload.username || null,
    payload.accountId || null,
    payload.cpanelUser || null,
    payload.metadata ? JSON.stringify(payload.metadata) : null,
    expiresAt
  );

  return {
    id: sessionId,
    role: payload.role,
    username: payload.username || null,
    accountId: payload.accountId || null,
    cpanelUser: payload.cpanelUser || null,
    expiresAt
  };
}

function signSessionToken(session) {
  return jwt.sign(
    {
      sid: session.id,
      role: session.role,
      username: session.username || null,
      account_id: session.accountId || null,
      cpanel_user: session.cpanelUser || null
    },
    JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS }
  );
}

function issueSession(res, payload) {
  const session = createSessionRecord(payload);
  const token = signSessionToken(session);
  setCookie(res, SESSION_COOKIE, token, sessionCookieOptions());
  return session;
}

function mapSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    role: row.role,
    username: row.username,
    accountId: row.account_id,
    cpanelUser: row.cpanel_user || row.account_cpanel_user || null,
    expiresAt: row.expires_at,
    account: row.account_id
      ? {
          id: row.account_id,
          cpanel_user: row.account_cpanel_user || row.cpanel_user,
          domain: row.domain,
          plan: row.plan,
          status: row.account_status,
          server_slug: row.server_slug,
          server_name: row.server_name
        }
      : null
  };
}

function readSession(req) {
  const token = getCookie(req, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const row = db.prepare(`
      SELECT
        s.*,
        a.cpanel_user AS account_cpanel_user,
        a.domain,
        a.plan,
        a.status AS account_status,
        srv.slug AS server_slug,
        srv.name AS server_name
      FROM sessions s
      LEFT JOIN accounts a ON a.id = s.account_id
      LEFT JOIN servers srv ON srv.id = a.server_id
      WHERE s.id = ? AND s.revoked_at IS NULL
    `).get(decoded.sid);

    if (!row) {
      return null;
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      revokeSession(row.id);
      return null;
    }

    db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return mapSessionRow(row);
  } catch {
    return null;
  }
}

function revokeSession(sessionId) {
  const db = getDb();
  db.prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
}

function clearSession(res, req) {
  if (req?.session?.id) {
    revokeSession(req.session.id);
  }

  clearCookie(res, SESSION_COOKIE, sessionCookieOptions());
}

module.exports = {
  clearSession,
  issueSession,
  readSession,
  revokeSession
};
