// GET /api/session -> 200 if the HttpOnly session cookie is still valid,
// 401 otherwise. Used on page load so a refresh doesn't re-prompt for the
// passcode as long as the real (server-side) session is still valid --
// unlike sessionStorage, which the server-side login flow never set.
const { isValidSession } = require('./_auth');

module.exports = async (req, res) => {
  if (isValidSession(req)) return res.status(200).json({ authed: true });
  return res.status(401).json({ authed: false });
};
