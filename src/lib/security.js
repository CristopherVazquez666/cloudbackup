const crypto = require('crypto');

function generateId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeCompare(a, b) {
  if (!a || !b) {
    return false;
  }

  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeServerSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCpanelUser(value) {
  return String(value || '').trim();
}

function isSafeServerSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(normalizeServerSlug(value));
}

function isSafeCpanelUser(value) {
  return /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(normalizeCpanelUser(value));
}

function isSafeDomain(value) {
  return /^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$/i.test(normalizeDomain(value));
}

function signSsoPayload({ serverSlug, cpanelUser, domain, timestamp, nonce }, sharedSecret) {
  const canonical = [
    normalizeServerSlug(serverSlug),
    normalizeCpanelUser(cpanelUser),
    normalizeDomain(domain),
    String(timestamp || '').trim(),
    String(nonce || '').trim()
  ].join('\n');

  return crypto.createHmac('sha256', sharedSecret).update(canonical).digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml,
  generateId,
  isSafeCpanelUser,
  isSafeDomain,
  isSafeServerSlug,
  normalizeCpanelUser,
  normalizeDomain,
  normalizeServerSlug,
  safeCompare,
  signSsoPayload
};
