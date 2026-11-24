// Transcription smoke test (read-only): serves ./dashboard locally, signs in as a throwaway admin and runs the
// in-browser Whisper transcriber on the newest recording in the transcription queue. Prints the text; saves nothing.
// Usage: node tests/e2e/transcribe.mjs   (first run downloads the speech model, ~80 MB)
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
const PORT = 9335; const WEB = 5598;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DASH, rel);
  if (!file.startsWith(DASH) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB, '127.0.0.1');
const findChromium = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found');
};

let SR; let userId; let chrome; let userDir; let ok = false;
try {
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
  SR = keys.find((k) => k.name === 'service_role').api_key;
  const email = `e2e-tx-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  userId = u.id;
  await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `insert into profiles (user_id, role) values ('${userId}', 'admin')` }) });
  const jwt = (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json()).access_token;
  // newest Coco call recording (else newest voicemail with audio)
  const sqlq = async (query) => (await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json());
  const q = await sqlq(`select * from (select 'recording' kind, path, agent_path, caller_path, started_at at_ from call_recordings where agent_id in (select id from agents where name not like 'E2E%') order by started_at desc limit 1) a
    union all select * from (select 'voicemail', recording_path, null, null, occurred_at from messages where kind = 'voicemail' and recording_path is not null order by occurred_at desc limit 1) b`);
  if (!q.length) { console.log('SKIP  no recordings'); ok = true; throw new Error('skip'); }
  const sign = async (p) => (p ? `${URL_}/storage/v1${(await (await fetch(`${URL_}/storage/v1/object/sign/recordings/${p}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) })).json()).signedURL}` : null);
  const src = { mixUrl: await sign(q[0].path), agentUrl: await sign(q[0].agent_path), callerUrl: await sign(q[0].caller_path), voicemail: q[0].kind === 'voicemail' };

  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-tx-'));
  chrome = spawn(findChromium(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ } await sleep(250); }
  const cdp = await CDP.connect(PORT);
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${WEB}/transcriber.js` });
  const s = await cdp.attach(targetId);
  await sleep(1500);
  const t0 = Date.now();
  const out = await cdp.eval(s, `import('/transcriber.js').then((t) => t.transcribeSources(${JSON.stringify(src)})).then((o) => ({ text: o.text, model: o.model, answeredBy: o.answeredBy })).catch((e) => ({ error: String(e) }))`);
  console.log(`${q[0].kind} from ${q[0].at_}${q[0].agent_path ? ' (per-speaker files)' : ' (mixed file)'}, ${Math.round((Date.now() - t0) / 1000)} s, answered by: ${out.answeredBy}`);
  console.log(out.error ? `FAIL  ${out.error}` : `PASS  ${out.model}:
${out.text}`);
  ok = !out.error && typeof out.text === 'string';
  cdp.close();
} catch (e) { if (e.message !== 'skip') console.log('FAIL ', e.message); } finally {
  try { chrome?.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { if (userDir) fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (userId) await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  server.close();
}
process.exit(ok ? 0 : 1);
