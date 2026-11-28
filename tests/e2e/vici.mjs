// Vici Dialer, against the REAL backend: real extension in Chromium + a mocked Vici agent screen
// (https://dm26.callengine.org/agc/vicidial.php) whose browser phone stays connected for the whole login, like Vici's.
// Verifies: nothing is recorded while no customer is on the line; a customer call is captured (lead, phone, campaign,
// disposition) into vici_calls only (Google Voice tables untouched); its recording covers just the call, is linked to
// the Vici call and queued for transcription; the dashboard RPCs show it to the admin only.
// Usage: node tests/e2e/vici.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'extension');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.SUPABASE_URL;
const ANON = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8').match(/eyJ[^']+/)[0];
const PORT = 9335;
const TZ = 'Asia/Karachi';

const results = [];
const check = (name, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !d ? '' : `\n      ↳ ${d}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 300) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
  return last;
}
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json(); if (!r.ok || j.message) throw new Error(`SQL: ${j.message || r.status}`); return j;
};
const findChromium = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found; set CHROMIUM=');
};
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const created = { users: [], agentId: null, chrome: null, userDir: null };
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
const SR = keys.find((k) => k.name === 'service_role').api_key;
async function mkUser(role, agentId) {
  const email = `e2e-vici-${role}-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  created.users.push(u.id);
  await sql(`insert into profiles (user_id, role, agent_id) values ('${u.id}', '${role}', ${role === 'agent' ? `'${agentId}'` : 'null'})`);
  return (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json()).access_token;
}
const rpc = async (jwt, fn, body) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); return t ? JSON.parse(t) : null;
};

// Mock Vici agent screen. The "browser phone" (loopback WebRTC: fake mic = agent, 440 Hz tone in a frame = caller)
// connects at login and stays up. __call(sec) puts a customer on the line for sec seconds, then picks a disposition.
const PAGE = `<!doctype html><html><head><title>mock vici</title></head><body><h1>Mock Vici agent screen</h1>
<form name="vicidial_form"><input name="lead_id"><input name="uniqueid"><input name="phone_code"><input name="phone_number">
<input name="first_name"><input name="last_name"></form><script>
  var VD_live_customer_call = 0, auto_dial_level = 1, campaign = 'E2ECAMP', user = '8001', inOUT = 'OUT', VDCL_group_id = '';
  async function phone() {
    const f = document.createElement('iframe'); f.srcdoc = '<p>caller</p>'; document.body.appendChild(f);
    await new Promise((r) => f.addEventListener('load', r, { once: true }));
    const W = f.contentWindow;
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const a = new RTCPeerConnection(); const b = new W.RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ctx = new W.AudioContext(); const osc = ctx.createOscillator(); const dst = ctx.createMediaStreamDestination();
    osc.frequency.value = 440; osc.connect(dst); osc.start(); await ctx.resume();
    dst.stream.getTracks().forEach((t) => b.addTrack(t, dst.stream));
    mic.getTracks().forEach((t) => a.addTrack(t, mic));
    b.ontrack = (e) => { const el = new W.Audio(); el.muted = true; el.srcObject = e.streams[0]; el.play().catch(() => {}); };
    const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
    const ans = await b.createAnswer(); await b.setLocalDescription(ans); await a.setRemoteDescription(ans);
    document.title = 'phone ready';
  }
  const F = document.forms.vicidial_form.elements;
  const ajax = (body) => new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', 'vdc_db_query.php'); x.onload = r; x.send(body); });
  window.__call = async (sec, uid) => {
    F.lead_id.value = '9001'; F.uniqueid.value = uid; F.phone_code.value = '1'; F.phone_number.value = '3075550142';
    F.first_name.value = 'Vici'; F.last_name.value = 'Lead';
    VD_live_customer_call = 1;
    await new Promise((r) => setTimeout(r, sec * 1000));
    VD_live_customer_call = 0;
    await new Promise((r) => setTimeout(r, 1500));
    await ajax('ACTION=updateDISPO&user=8001&pass=TOPSECRET&dispo_choice=SALE&lead_id=9001');
    document.title = 'call done';
  };
  phone();
</script></body></html>`;

async function browserPart(token, agentId, adminJwt) {
  created.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-vici-'));
  created.chrome = spawn(findChromium(), [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${created.userDir}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000);
  const cdp = await CDP.connect(PORT);
  const sw = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 20000);
  check('extension service worker starts', sw);
  if (!sw) return;
  const extId = sw.url.split('/')[2];
  const swS = await cdp.attach(sw.targetId);
  const store = () => cdp.eval(swS, 'chrome.storage.local.get(null)');
  const seenReq = [];
  cdp.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    seenReq.push(`${request.url} ${request.postData || ''}`);
    const html = /vicidial\.php/.test(request.url);
    await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: html ? 'text/html' : 'text/plain' }],
      body: Buffer.from(html ? PAGE : 'OK').toString('base64') }, m.sessionId).catch(() => {});
  });
  const { targetId: optId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options/options.html` });
  const optS = await cdp.attach(optId);
  await waitFor(() => cdp.eval(optS, "document.readyState === 'complete'"), 10000);
  const con = await cdp.eval(optS, `chrome.runtime.sendMessage({ type: 'connect', token: '${token}' })`);
  check('extension connects with the agent token', con?.ok, JSON.stringify(con));
  await waitFor(async () => (await store()).recordCalls === true, 15000);

  const { targetId: pageId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const pageS = await cdp.attach(pageId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://dm26.callengine.org/*' }] }, pageS);
  await cdp.send('Page.navigate', { url: 'https://dm26.callengine.org/agc/vicidial.php' }, pageS);
  check('Vici hook + recorder active on the agent screen', await waitFor(() => cdp.eval(pageS, 'window.__cocoVici === 1 && window.__cocoRecorder >= 1'), 10000));
  check('browser phone connected (WebRTC up for the whole login)', await waitFor(() => cdp.eval(pageS, "document.title === 'phone ready'"), 15000));

  // phone connected, no customer: nothing may be recorded
  await sleep(5000);
  const idle = await store();
  check('no recording while the phone is connected but no customer is on the line', !idle.recState?.on, JSON.stringify(idle.recState));
  const panel = await waitFor(async () => (await store()).status?.text === 'Tracking Vici Dialer', 8000);
  check('extension status says "Tracking Vici Dialer" (Google Voice not open)', panel);

  const uid = `E2E${Date.now()}.42`;
  cdp.eval(pageS, `window.__call(6, '${uid}')`).catch(() => {});
  check('REC turns on when the customer is on the line', await waitFor(async () => (await store()).recState?.on === true, 8000, 200));
  await waitFor(() => cdp.eval(pageS, "document.title === 'call done'"), 20000);
  check('REC turns off at hangup', await waitFor(async () => (await store()).recState?.on === false, 8000, 200));

  const row = await waitFor(async () => { const [r] = await sql(`select * from vici_calls where agent_id='${agentId}'`); return r?.disposition && r; }, 45000, 1000);
  check('Vici call synced to vici_calls', row?.vici_uid === uid, JSON.stringify(row));
  check('lead details captured (phone, name, lead, campaign, auto dial, user)', row && row.phone === '+13075550142' && row.contact_name === 'Vici Lead'
    && row.lead_id === '9001' && row.campaign === 'E2ECAMP' && row.dial_type === 'auto' && row.vici_user === '8001', JSON.stringify(row));
  check('disposition captured (SALE)', row?.disposition === 'SALE');
  check('talk time ≈ call length (5–8 s)', row && row.talk_sec >= 5 && row.talk_sec <= 8, `talk ${row?.talk_sec}`);
  const [gvc] = await sql(`select (select count(*) from calls where agent_id='${agentId}')::int calls, (select count(*) from messages where agent_id='${agentId}')::int msgs,
    (select count(*) from v_activity where agent_id='${agentId}')::int act`);
  check('nothing written to Google Voice tables / metrics', gvc.calls === 0 && gvc.msgs === 0 && gvc.act === 0, JSON.stringify(gvc));

  const rec = await waitFor(async () => { const [r] = await sql(`select * from call_recordings where agent_id='${agentId}'`); return r?.vici_call_id && r.agent_path && r.caller_path && r; }, 60000, 1000);
  check('recording uploaded, tagged Vici, linked to the Vici call', rec?.source === 'vici' && rec.vici_uid === uid && rec.vici_call_id === row?.id, JSON.stringify(rec));
  check('recording covers only the customer call (4–9 s, not the whole login)', rec && rec.duration_sec >= 4 && rec.duration_sec <= 9, `dur ${rec?.duration_sec}`);
  check('Google Voice matcher left it alone (call_id empty)', rec && rec.call_id === null);
  const job = await waitFor(async () => { const [j] = await sql(`select status from transcription_jobs where ref_id='${rec?.id}'`); return j && j.status !== 'pending' && j; }, 30000, 1000);
  check('transcription picked up automatically (same pipeline as Google Voice)', ['done', 'no_provider', 'working', 'failed'].includes(job?.status), JSON.stringify(job));

  const signed = await (await fetch(`${URL_}/storage/v1/object/sign/recordings/${rec.path}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) })).json();
  const rms = await cdp.eval(pageS, `(async () => {
    const buf = await (await fetch(${JSON.stringify(`${URL_}/storage/v1${signed.signedURL}`)})).arrayBuffer();
    const ab = await new AudioContext().decodeAudioData(buf);
    const r = (ch) => { const d = ab.getChannelData(ch); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    return { channels: ab.numberOfChannels, left: r(0), right: ab.numberOfChannels > 1 ? r(1) : 0 };
  })()`).catch((e) => ({ error: String(e) }));
  check('both sides audible (agent left, caller right)', rms?.channels === 2 && rms.left > 0.001 && rms.right > 0.001, JSON.stringify(rms));

  const st = await store();
  check('panel gets Vici numbers for today', st.viciSummary?.calls === 1, JSON.stringify(st.viciSummary));
  const leaked = JSON.stringify(st).includes('TOPSECRET') || JSON.stringify(await sql(`select vici_health::text h from agents where id='${agentId}'`)).includes('TOPSECRET');
  check('Vici password never stored by the extension or sent to the server', !leaked);
  check('page requests were never blocked or changed (dispo request reached Vici)', seenReq.some((x) => /updateDISPO/.test(x) && /TOPSECRET/.test(x)));
  cdp.close();
  return row;
}

async function dashboardPart(agentId, adminJwt, agentJwt, row) {
  const args = { p_from: todayKey, p_to: todayKey, p_agent: agentId };
  const sum = await rpc(adminJwt, 'vici_summary', args);
  check('admin: Vici summary counts the call', sum?.[0]?.calls === 1 && sum[0].vici_user === '8001', JSON.stringify(sum).slice(0, 200));
  const list = await rpc(adminJwt, 'vici_calls_list', args);
  check('admin: call list has recording', list?.[0]?.id === row?.id && !!list[0].recording_path, JSON.stringify(list).slice(0, 200));
  const d = await rpc(adminJwt, 'vici_dispositions', args);
  check('admin: dispositions show SALE', d?.some?.((x) => x.disposition === 'SALE'), JSON.stringify(d));
  const own = await rpc(agentJwt, 'vici_calls_list', { p_from: todayKey, p_to: todayKey });
  check('agent sees own Vici calls but no recordings/transcripts', own?.length === 1 && !own[0].recording_path && !own[0].transcript, JSON.stringify(own).slice(0, 200));
  const direct = await fetch(`${URL_}/rest/v1/vici_calls?select=id`, { headers: { apikey: ANON, Authorization: `Bearer ${agentJwt}` } }).then((r) => r.json());
  check('agent cannot read the vici_calls table directly', Array.isArray(direct) && direct.length === 0, JSON.stringify(direct).slice(0, 120));
  const gvSum = await rpc(adminJwt, 'metrics_summary', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
  check('Google Voice overview shows 0 calls for this agent (not mixed)', Number(gvSum?.[0]?.outbound_calls ?? 0) === 0 && Number(gvSum?.[0]?.outbound_total ?? 0) === 0, JSON.stringify(gvSum).slice(0, 200));
}

async function cleanup() {
  try { created.chrome?.kill(); } catch { /* ignore */ }
  await sleep(800);
  try { if (created.userDir) fs.rmSync(created.userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const id of created.users) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  if (created.agentId) {
    const files = await sql(`select name from storage.objects where bucket_id='recordings' and name like '${created.agentId}/%'`).catch(() => []);
    if (files.length) await fetch(`${URL_}/storage/v1/object/recordings`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: files.map((f) => f.name) }) }).catch(() => {});
    await sql(`delete from transcription_jobs where agent_id = '${created.agentId}' or ref_id in (select id from call_recordings where agent_id = '${created.agentId}')`).catch(() => {});
    await sql(`delete from agents where id = '${created.agentId}'`).catch(() => {});
  }
}

try {
  const token = `coco_${crypto.randomBytes(24).toString('hex')}`;
  const [{ id: agentId }] = await sql(`insert into agents (name, token_hash, token_hint, account_type) values ('E2E Vici', '${crypto.createHash('sha256').update(token).digest('hex')}', '${token.slice(-4)}', 'workspace') returning id`);
  created.agentId = agentId;
  const adminJwt = await mkUser('admin');
  const agentJwt = await mkUser('agent', agentId);
  const row = await browserPart(token, agentId, adminJwt);
  await dashboardPart(agentId, adminJwt, agentJwt, row);
} catch (e) { check('test run completed without crashing', false, e.stack || String(e)); } finally { await cleanup(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
