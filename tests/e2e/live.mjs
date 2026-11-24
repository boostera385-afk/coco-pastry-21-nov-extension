// Live dashboard check: serves ./dashboard locally, signs in as a throwaway admin, opens Overview (Yesterday range on
// purpose: live updates must not depend on the range), then a throwaway agent sends a call through /ingest.
// Passes when the open page shows it without any click, within 20 s. Cleans up after itself.
// Usage: node tests/e2e/live.mjs
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
const PORT = 9336; const WEB = 5597;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json(); if (!r.ok || j.message) throw new Error(j.message || r.status); return j;
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DASH, rel);
  if (!file.startsWith(DASH) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB, '127.0.0.1');
const findChromium = () => {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found');
};

let SR; let userId; let agentId; let chrome; let userDir; let ok = false;
try {
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
  SR = keys.find((k) => k.name === 'service_role').api_key;
  const token = `coco_${crypto.randomBytes(24).toString('hex')}`;
  [{ id: agentId }] = await sql(`insert into agents (name, token_hash, token_hint, account_type, tracking_start) values ('E2E Live', '${crypto.createHash('sha256').update(token).digest('hex')}', '${token.slice(-4)}', 'workspace', now() - interval '3 days') returning id`);
  const email = `e2e-live-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  userId = u.id;
  await sql(`insert into profiles (user_id, role) values ('${userId}', 'admin')`);

  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-live-'));
  chrome = spawn(findChromium(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000);
  const cdp = await CDP.connect(PORT);
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${WEB}/` });
  const s = await cdp.attach(targetId);
  await waitFor(() => cdp.eval(s, "!!document.getElementById('pwForm') && document.readyState === 'complete'"), 20000);
  await cdp.eval(s, `document.getElementById('email').value = ${JSON.stringify(email)}; document.getElementById('password').value = ${JSON.stringify(pw)}; document.querySelector('#pwForm button[type=submit]').click(); true`);
  await waitFor(() => cdp.eval(s, "!document.getElementById('app').hidden && !!document.querySelector('.kpis')"), 20000);
  await cdp.eval(s, "document.getElementById('guideLater')?.click(); localStorage.removeItem('coco.range'); document.querySelector('#range [data-r=\"7d\"]').click(); true");
  await waitFor(() => cdp.eval(s, "!!document.querySelector('.kpis')"), 10000);
  await sleep(12000); // first stamp
  const rowText = () => cdp.eval(s, "[...document.querySelectorAll('table.team tbody tr')].map((r) => r.textContent).find((t) => t.includes('E2E Live')) || ''");
  const before = await rowText();
  const gv = `E2ELIVE${crypto.randomBytes(5).toString('hex')}`;
  const sent = Date.now();
  await fetch(`${URL_}/functions/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': token }, body: JSON.stringify({ parser_version: 'e2e', events: [
    { type: 'call', gv_id: gv, gv_thread_id: `c.${gv}`, agent_number: '+15550001111', contact_number: '+15550109999', direction: 'outbound', occurred_at: new Date().toISOString(), call_outcome: 'connected', duration_sec: 75, type_code: 14 }] }) });
  const after = await waitFor(async () => { const t = await rowText(); return /E2E Live/.test(t) && t !== before && /\b1\b/.test(t) && t; }, 25000);
  const secs = Math.round((Date.now() - sent) / 1000);
  ok = !!after;
  console.log(`${ok ? 'PASS' : 'FAIL'}  open dashboard shows a new call by itself (${secs} s)${ok ? '' : `\n      before: ${before.slice(0, 120)}`}`);
  const live = await cdp.eval(s, "document.getElementById('live')?.textContent || ''");
  console.log(`${/Live/.test(live) ? 'PASS' : 'FAIL'}  live indicator shows "${live}"`);
  ok = ok && /Live/.test(live);
  cdp.close();
} catch (e) { console.log('FAIL ', e.message); } finally {
  try { chrome?.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { if (userDir) fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (userId) await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  if (agentId) await sql(`delete from agents where id='${agentId}'`).catch(() => {});
  await sql("delete from contacts where phone_e164 = '+15550109999'").catch(() => {});
  server.close();
}
process.exit(ok ? 0 : 1);
