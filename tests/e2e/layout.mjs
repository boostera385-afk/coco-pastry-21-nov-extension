// Responsive layout check: serves ./dashboard locally, signs in as a throwaway admin and verifies
// no page scrolls sideways at desktop, side-panel-open, tablet and phone widths. Deletes the user after.
// Usage: node tests/e2e/layout.mjs   (writes screenshots to $SHOTS dir if set)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DASH = path.join(ROOT, 'dashboard');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.SUPABASE_URL;
const ANON = fs.readFileSync(path.join(DASH, 'config.js'), 'utf8').match(/eyJ[^']+/)[0];
const PORT = 9334; const WEB = 5599;
const WIDTHS = [1400, 960, 760, 390];
const PAGES = ['overview', 'contacts', 'conversations', 'analysis', 'settings', 'account'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DASH, rel);
  if (!file.startsWith(DASH) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB, '127.0.0.1');

let SR; let userId; let chrome; let userDir; let fails = 0;
try {
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
  SR = keys.find((k) => k.name === 'service_role').api_key;
  const email = `e2e-layout-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  userId = u.id;
  await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `insert into profiles (user_id, role) values ('${userId}', 'admin')` }) });

  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dir = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-layout-'));
  chrome = spawn(path.join(base, dir, 'chrome-win64', 'chrome.exe'), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const cdp = await CDP.connect(PORT);
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${WEB}/` });
  const s = await cdp.attach(targetId);
  await waitFor(() => cdp.eval(s, "!!document.getElementById('pwForm') && document.readyState === 'complete'"), 20000);
  await cdp.eval(s, `document.getElementById('email').value = ${JSON.stringify(email)}; document.getElementById('password').value = ${JSON.stringify(pw)}; document.querySelector('#pwForm button[type=submit]').click(); true`);
  if (!await waitFor(() => cdp.eval(s, "!document.getElementById('app').hidden && !!document.querySelector('.kpis')"), 20000)) throw new Error('sign-in failed');

  for (const w of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 }, s);
    for (const p of PAGES) {
      await cdp.eval(s, `location.hash = '#/${p}'; true`);
      await sleep(2500);
      const r = await cdp.eval(s, `(() => {
        const W = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')].filter((e) => {
          if (e.closest('.table-wrap, .timeline, .list, .links') && !e.matches('.table-wrap, .timeline, .list, .links')) return false;
          const b = e.getBoundingClientRect(); return b.width && b.right > W + 1 && getComputedStyle(e).position !== 'fixed';
        }).slice(0, 3).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ' ' + Math.round(e.getBoundingClientRect().right));
        return { W, sw: document.documentElement.scrollWidth, wide };
      })()`);
      const ok = r.sw <= r.W + 1 && !r.wide.length;
      if (!ok) fails++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(w).padStart(4)}px ${p.padEnd(13)}${ok ? '' : ` scrollWidth ${r.sw} > ${r.W}  ${r.wide.join(' | ')}`}`);
      if (process.env.SHOTS && p === 'overview') {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
        fs.writeFileSync(path.join(process.env.SHOTS, `overview-${w}.png`), Buffer.from(data, 'base64'));
      }
    }
  }
  cdp.close();
} catch (e) { fails++; console.log('FAIL  run:', e.message); } finally {
  if (userId) await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  chrome?.kill(); server.close();
  await sleep(500); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(fails ? `\n${fails} layout problem(s)` : '\nall layouts fit');
  process.exitCode = fails ? 1 : 0;
}
