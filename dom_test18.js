const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('public/index.html', 'utf-8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', resources: 'usable' });
const { window } = dom;
global.window = window; global.document = window.document;
global.sessionStorage = window.sessionStorage; global.localStorage = window.localStorage; global.crypto = window.crypto;
let fetchLog = [];
global.fetch = async (url) => {
  fetchLog.push(url);
  let filePath = null;
  if (url === 'toc_mapping.json') filePath = 'public/toc_mapping.json';
  else if (url === 'targets.json') filePath = 'public/targets.json';
  else if (url === 'marketplace_mapping.json') filePath = 'public/marketplace_mapping.json';
  else if (url.startsWith('targets_monthly/')) filePath = 'public/' + url;
  else if (url.startsWith('data/')) filePath = 'public/' + url;
  else if (url.startsWith('/api/')) return { ok: false, status: 404, json: async()=>({}) }; // simulate API not deployed, like a local/fresh test
  if (filePath && fs.existsSync(filePath)) { const c = fs.readFileSync(filePath, 'utf-8'); return { ok: true, json: async () => JSON.parse(c) }; }
  return { ok: false, status: 404, json: async()=>({}) };
};
window.fetch = global.fetch;
global.Chart = window.Chart = function() { this.destroy = () => {}; };
global.Papa = window.Papa = { parse: () => {} };
const appjs = fs.readFileSync('public/app.js', 'utf-8');
window.eval(appjs);

(async () => {
  await new Promise(r => setTimeout(r, 200)); // let boot() + initial onMonthChange (via refreshMonthList) finish

  console.log('=== After boot ===');
  console.log('monthSelect options:', Array.from(document.getElementById('monthSelect').options).map(o=>o.value));
  console.log('monthSelect current value:', document.getElementById('monthSelect').value);
  console.log('periodBadge:', document.getElementById('periodBadge').textContent);
  console.log('R&D first row (should be August data):', document.getElementById('rdBody').innerHTML.replace(/\s+/g,' ').slice(0,150));

  console.log();
  console.log('=== User manually selects 2026-07 from dropdown ===');
  document.getElementById('monthSelect').value = '2026-07';
  await window.onMonthChange();
  console.log('periodBadge:', document.getElementById('periodBadge').textContent);
  console.log('R&D first row (should now be JULY data, different numbers):', document.getElementById('rdBody').innerHTML.replace(/\s+/g,' ').slice(0,150));

  console.log();
  console.log('=== fetch calls made for month switch (last 5) ===');
  console.log(fetchLog.slice(-5));
})();
