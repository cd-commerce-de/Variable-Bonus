// POST /api/save-month  body: computed month JSON (must include .month = "YYYY-MM")
// Commits data/<month>.json to the private GitHub repo via the Contents API.
// Requires a valid session. GITHUB_TOKEN here needs Contents: Read & Write
// on this one repo (fine-grained PAT), kept server-side only.
const { isValidSession } = require('./_auth');

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isValidSession(req)) return res.status(401).json({ error: 'Not authenticated' });
  if (!OWNER || !REPO || !TOKEN) return res.status(500).json({ error: 'Server not configured.' });

  const body = req.body;
  if (!body || !/^\d{4}-\d{2}$/.test(body.month || '')) {
    return res.status(400).json({ error: 'Body must include month: "YYYY-MM"' });
  }
  const path = `data/${body.month}.json`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };

  // Need the existing file's sha if it exists, to update rather than create.
  let sha;
  const existing = await fetch(`${apiUrl}?ref=${BRANCH}`, { headers });
  if (existing.ok) sha = (await existing.json()).sha;

  const contentB64 = Buffer.from(JSON.stringify(body, null, 1)).toString('base64');
  const commitRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update bonus data for ${body.month}`,
      content: contentB64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!commitRes.ok) {
    const err = await commitRes.text();
    return res.status(502).json({ error: 'GitHub commit failed', detail: err });
  }
  res.status(200).json({ ok: true, month: body.month });
};
