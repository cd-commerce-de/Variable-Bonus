// POST /api/logout -> clears the session cookie so "Lock" actually ends
// the session, rather than just hiding the UI while the cookie (and thus
// access) stays valid underneath.
module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', 'cdc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
};
