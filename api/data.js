// GET /api/data?month=YYYY-MM   -> one month's computed JSON
// GET /api/data?list=1          -> list of months saved in the repo
//
// Requires a valid session (see _auth.js / login.js). Reads from the
// private GitHub repo using GITHUB_TOKEN, a fine-grained PAT scoped to
// this one repo with read access to Contents. The token lives only in
// Vercel's server environment -- it is never sent to the browser.
const { isValidSession } = require('./_auth');

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN;

async function ghFetch(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' } });
  return r;
}

module.exports = async (req, res) => {
  if (!isValidSession(req)) return res.status(401).json({ error: 'Not authenticated' });
  if (!OWNER || !REPO || !TOKEN) return res.status(500).json({ error: 'Server not configured: set GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN.' });

  if (req.query.list) {
    const r = await ghFetch('data');
    if (!r.ok) return res.status(200).json({ months: [] });
    const listing = await r.json();
    const months = listing.filter(f => f.name.endsWith('.json')).map(f => f.name.replace('.json', ''));
    return res.status(200).json({ months });
  }

  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Provide ?month=YYYY-MM' });

  const r = await ghFetch(`data/${month}.json`);
  if (!r.ok) return res.status(404).json({ error: 'Month not found' });
  const file = await r.json();
  const content = Buffer.from(file.content, 'base64').toString('utf-8');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(content);
};
