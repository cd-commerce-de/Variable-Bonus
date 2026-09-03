// POST { passcode } -> sets a signed, HttpOnly session cookie if correct.
// The real secret (DASHBOARD_PASSCODE) lives only in Vercel's server
// environment variables -- it is never sent to the browser, unlike the
// placeholder check in public/app.js which is for local testing only.
const crypto = require('crypto');

function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${mac}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { passcode } = req.body || {};
  const expected = process.env.DASHBOARD_PASSCODE;
  const cookieSecret = process.env.COOKIE_SECRET;

  if (!expected || !cookieSecret) {
    return res.status(500).json({ error: 'Server not configured: set DASHBOARD_PASSCODE and COOKIE_SECRET in Vercel env vars.' });
  }

  // Constant-time compare to avoid timing side-channels.
  const a = Buffer.from(passcode || '');
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) return res.status(401).json({ error: 'Incorrect passcode' });

  const expiry = Date.now() + 1000 * 60 * 60 * 12; // 12 hour session
  const token = sign(String(expiry), cookieSecret);
  res.setHeader('Set-Cookie', `cdc_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  res.status(200).json({ ok: true });
};
