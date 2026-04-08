function parseCookies(req) {
  const header = req.headers.cookie;

  if (!header) {
    return {};
  }

  return header.split(';').reduce((acc, part) => {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name) {
      return acc;
    }

    acc[name] = decodeURIComponent(valueParts.join('=') || '');
    return acc;
  }, {});
}

function getCookie(req, name) {
  return parseCookies(req)[name];
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function setCookie(res, name, value, options = {}) {
  res.append('Set-Cookie', serializeCookie(name, value, options));
}

function clearCookie(res, name, options = {}) {
  res.append(
    'Set-Cookie',
    serializeCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0
    })
  );
}

module.exports = {
  clearCookie,
  getCookie,
  parseCookies,
  setCookie
};
