const crypto = require('crypto');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

function isValidSession(req) {
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) return false;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['cdc_session'];
  if (!token) return false;
  const [expiryStr, mac] = token.split('.');
  if (!expiryStr || !mac) return false;
  const expectedMac = crypto.createHmac('sha256', cookieSecret).update(expiryStr).digest('hex');
  const a = Buffer.from(mac); const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() < Number(expiryStr);
}

module.exports = { isValidSession };
