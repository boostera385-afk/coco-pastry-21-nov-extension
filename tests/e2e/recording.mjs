// Plan B call recording + transcripts + shifts + analytics, against the REAL backend.
// Browser part: real extension in Chromium, mocked voice.google.com that makes a loopback WebRTC "call"
// (fake microphone = agent, oscillator in a separate frame = caller). Verifies the extension records it,
// uploads it, the server links it to the call, and BOTH channels contain audio. Then the admin switch
// turns recording off and the next call is not recorded.
// Backend part: transcripts (save/search/queue, admin only), shift report + shift issues, heatmap, team stats.
// Usage: node tests/e2e/recording.mjs
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
const ING = `${URL_}/functions/v1/ingest`;
const PORT = 9334;
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
let SR;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
SR = keys.find((k) => k.name === 'service_role').api_key;
async function mkUser(role, agentId) {
  const email = `e2e-rec-${role}-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  created.users.push(u.id);
  await sql(`insert into profiles (user_id, role, agent_id) values ('${u.id}', '${role}', ${role === 'agent' ? `'${agentId}'` : 'null'})`);
  return (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json()).access_token;
}
const rpc = async (jwt, fn, body) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

// Mock Voice page. "#call=<sec>" makes a loopback call: pc A (this page, hooked by the recorder) sends the fake mic;
// pc B lives in a same-origin srcdoc frame (not hooked) and sends a 440 Hz tone = the caller.
const PAGE = `<!doctype html><html><head><title>mock voice</title></head><body><h1>Mock Google Voice</h1><script>
  async function call(sec) {
    document.title = 'calling';
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
    await new Promise((r) => setTimeout(r, sec * 1000));
    a.close(); b.close(); mic.getTracks().forEach((t) => t.stop()); ctx.close();
    document.title = 'call done';
  }
  window.__call = call;
  document.title = 'loaded';
</script></body></html>`;

async function browserPart(token, agentId, adminJwt) {
  created.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-rec-'));
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

  cdp.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId } = m.params;
    await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(PAGE).toString('base64') }, m.sessionId).catch(() => {});
  });
  // connect the extension (same message the Settings page sends)
  const { targetId: optId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options/options.html` });
  const optS = await cdp.attach(optId);
  await waitFor(() => cdp.eval(optS, "document.readyState === 'complete'"), 10000);
  const con = await cdp.eval(optS, `chrome.runtime.sendMessage({ type: 'connect', token: '${token}' })`);
  check('extension connects with the agent token', con?.ok, JSON.stringify(con));
  const st0 = await waitFor(async () => { const s = await store(); return s.recordCalls === true && s; }, 15000);
  check('server tells the extension that call recording is ON (default for every agent)', st0?.recordCalls === true, `recordCalls=${st0?.recordCalls}`);

  const { targetId: pageId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const pageS = await cdp.attach(pageId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://voice.google.com/*' }] }, pageS);
  await cdp.send('Page.navigate', { url: 'https://voice.google.com/u/0/calls' }, pageS);
  await waitFor(() => cdp.eval(pageS, "document.title === 'loaded'"), 15000);
  check('recorder script is active on the Voice page', await waitFor(() => cdp.eval(pageS, 'window.__cocoRecorder >= 1'), 5000));
  await sleep(1500); // content script pushes rec-config

  // ---- call 1: recorded ----
  const callStart = Date.now();
  cdp.eval(pageS, 'window.__call(7)').catch(() => {});
  const recOn = await waitFor(async () => (await store()).recState?.on === true, 8000, 200);
  check('REC state turns on during the call (widget/panel show it)', recOn);
  const recBadge = await waitFor(() => cdp.eval(pageS, "(() => { const h = document.getElementById('coco-voice-widget'); return !!h; })()"), 3000);
  check('widget present on the Voice page during the call', recBadge);
  await waitFor(() => cdp.eval(pageS, "document.title === 'call done'"), 20000);
  const recOff = await waitFor(async () => (await store()).recState?.on === false, 8000, 200);
  check('REC state turns off when the call ends', recOff);

  // the call event itself (as the parser would send it) — synced AFTER the recording, as happens in real life
  const gv = `E2EREC${crypto.randomBytes(5).toString('hex')}`;
  const rowsBefore = await waitFor(async () => { const r = await sql(`select id, path, duration_sec, bytes from call_recordings where agent_id='${agentId}'`); return r.length ? r : null; }, 45000, 1000);
  check('recording uploaded by the extension (call_recordings row)', rowsBefore?.length === 1, JSON.stringify(rowsBefore));
  const rec = rowsBefore?.[0];
  const parts = await waitFor(async () => { const [r] = await sql(`select agent_path, caller_path from call_recordings where agent_id='${agentId}'`); return r?.agent_path && r?.caller_path && r; }, 30000, 1000);
  check('per-speaker files uploaded too (agent + caller, for labelled transcripts)', /-agent\.webm$/.test(parts?.agent_path || '') && /-caller\.webm$/.test(parts?.caller_path || ''), JSON.stringify(parts));
  const job = await waitFor(async () => { const [j] = await sql(`select status from transcription_jobs j join call_recordings r on r.id = j.ref_id where r.agent_id='${agentId}'`); return j && j.status !== 'pending' && j; }, 30000, 1000);
  check('transcription starts automatically after the call (job picked up by the server)', ['done', 'no_provider', 'working', 'failed'].includes(job?.status), JSON.stringify(job));
  check('recording length ≈ call length (5–9 s)', rec && rec.duration_sec >= 5 && rec.duration_sec <= 9, `dur ${rec?.duration_sec}`);
  const ev = { type: 'call', gv_id: gv, gv_thread_id: `c.${gv}`, agent_number: '+15550001111', contact_number: '+15550107777', direction: 'outbound',
    occurred_at: new Date(callStart - 8000).toISOString(), body: null, call_outcome: 'connected', duration_sec: 7, type_code: 1 };
  await sql(`update agents set tracking_start = now() - interval '1 day' where id='${agentId}'`); // the dial started just before connect
  const ri = await fetch(ING, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': token }, body: JSON.stringify({ parser_version: 'e2e', events: [ev] }) });
  const rij = await ri.json();
  check('call event ingested', ri.ok && rij.accepted === 1, JSON.stringify(rij).slice(0, 200));
  const [linked] = await sql(`select k.recording_path, r.call_id = k.id ok from calls k join call_recordings r on r.agent_id = k.agent_id where k.agent_id='${agentId}' and k.gv_id='${gv}'`);
  check('server links the recording to the call (matched by time)', linked?.ok === true && linked.recording_path === rec?.path, JSON.stringify(linked));
  check('recording stored as rec-<id>.webm under the agent folder', /^[0-9a-f-]{36}\/rec-[0-9a-f-]{36}\.webm$/.test(rec?.path || ''), rec?.path);

  // both channels carry sound: agent (fake mic) left, caller (440 Hz tone) right
  const signed = await (await fetch(`${URL_}/storage/v1/object/sign/recordings/${rec.path}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) })).json();
  const rms = await cdp.eval(pageS, `(async () => {
    const buf = await (await fetch(${JSON.stringify(`${URL_}/storage/v1${signed.signedURL}`)})).arrayBuffer();
    const ab = await new AudioContext().decodeAudioData(buf);
    const r = (ch) => { const d = ab.getChannelData(ch); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    return { channels: ab.numberOfChannels, left: r(0), right: ab.numberOfChannels > 1 ? r(1) : 0, sec: ab.duration };
  })()`).catch((e) => ({ error: String(e) }));
  check('recording is stereo (agent left, caller right)', rms?.channels === 2, JSON.stringify(rms));
  check('agent channel has audio (fake microphone)', rms?.left > 0.001, JSON.stringify(rms));
  check('caller channel has audio (remote WebRTC track)', rms?.right > 0.001, JSON.stringify(rms));

  // ---- admin turns recording off for this agent -> next call is not recorded ----
  await sql(`update agents set record_calls = false where id='${agentId}'`);
  await cdp.eval(optS, "chrome.storage.local.set({ heartbeatPending: true }).then(() => chrome.runtime.sendMessage({ type: 'sync-now' }))");
  const off = await waitFor(async () => (await store()).recordCalls === false, 15000);
  check('admin switch off reaches the extension (recordCalls=false)', off);
  await sleep(1000);
  await cdp.eval(pageS, 'window.__call(4)').catch(() => {});
  await sleep(6000);
  const [{ n }] = await sql(`select count(*)::int n from call_recordings where agent_id='${agentId}'`);
  const pend = await cdp.eval(swS, "new Promise((res) => { const r = indexedDB.open('coco-recordings', 1); r.onsuccess = () => { const q = r.result.transaction('pending').objectStore('pending').count(); q.onsuccess = () => res(q.result); }; r.onerror = () => res(-1); })");
  check('with recording off, the next call is not recorded or uploaded', n === 1 && pend === 0, `rows ${n}, pending ${pend}`);
  const h = (await store());
  check('health report carries call-recording stats for the dashboard', h.recStats?.uploaded >= 1 && h.recDiag?.files >= 1, JSON.stringify({ s: h.recStats, d: h.recDiag }));
  cdp.close();
}

async function backendPart(token, agentId, adminJwt, agentJwt) {
  // recording upload checks (no browser)
  const id = crypto.randomUUID();
  const bad = await fetch(`${ING}?rec=${id}&start=${new Date().toISOString()}&dur=3`, { method: 'POST', headers: { 'x-agent-token': token, 'Content-Type': 'text/html' }, body: '<x>' });
  check('recording upload: non-audio rejected (415) — or skipped when recording is off', bad.status === 415 || (await bad.json()).skipped, String(bad.status));
  const badId = await fetch(`${ING}?rec=../../x&start=${new Date().toISOString()}`, { method: 'POST', headers: { 'x-agent-token': token, 'Content-Type': 'audio/webm' }, body: 'x' });
  check('recording upload: bad id rejected (400)', badId.status === 400);

  // transcripts: admin saves, agent cannot; queue + search
  const [call] = await sql(`select id from calls where agent_id='${agentId}' and recording_path is not null limit 1`);
  if (call) {
    const q1 = await rpc(adminJwt, 'transcription_queue', { p_limit: 500 });
    check('transcription queue lists the recorded call', Array.isArray(q1) && q1.some((x) => x.id === call.id), JSON.stringify(q1).slice(0, 200));
    const denied = await rpc(agentJwt, 'save_transcript', { p_kind: 'call', p_id: call.id, p_text: 'hack', p_source: 'whisper' });
    check('agent cannot save transcripts (admin only)', denied?.message || denied?.code, JSON.stringify(denied));
    await rpc(adminJwt, 'save_transcript', { p_kind: 'call', p_id: call.id, p_text: 'Agent: hello this is Coco about your refund\nCaller: thanks', p_source: 'whisper' });
    const [t] = await sql(`select transcript, transcript_source from calls where id='${call.id}'`);
    check('admin saves a transcript (source whisper)', /refund/.test(t?.transcript || '') && t.transcript_source === 'whisper', JSON.stringify(t));
    const found = await rpc(adminJwt, 'search_transcripts', { p_q: 'refund', p_from: todayKey, p_to: todayKey, p_agent: agentId });
    check('transcript search finds the call', Array.isArray(found) && found.some((x) => x.id === call.id), JSON.stringify(found).slice(0, 200));
    const agentSearch = await rpc(agentJwt, 'search_transcripts', { p_q: 'refund', p_from: todayKey, p_to: todayKey });
    check('agent search returns nothing (transcripts are admin only)', Array.isArray(agentSearch) && agentSearch.length === 0, JSON.stringify(agentSearch).slice(0, 120));
    const tl = await rpc(adminJwt, 'contact_timeline', { p_agent: agentId, p_contact: (await sql(`select contact_id from calls where id='${call.id}'`))[0].contact_id });
    check('conversation timeline returns row id, recording and transcript source', tl?.some?.((x) => x.id === call.id && x.recording_path && x.transcript_source === 'whisper'), JSON.stringify(tl).slice(0, 200));
  } else check('recorded call exists for transcript checks', false, 'browser part did not produce a linked recording');

  // shifts: a shift that started 3 h ago and ended 1 h ago today, with today's weekday; one outbound 2 h ago
  const [{ s0, s1, dow }] = await sql(`select to_char((now() at time zone 'Asia/Karachi') - interval '3 hours', 'HH24:MI') s0,
    to_char((now() at time zone 'Asia/Karachi') - interval '1 hour', 'HH24:MI') s1, extract(isodow from now() at time zone 'Asia/Karachi')::int dow`);
  const crossesDay = s1 < s0;
  if (!crossesDay) {
    const set = await rpc(adminJwt, 'update_agent_settings', { p_agent: agentId, p_record_calls: false, p_shift_start: s0, p_shift_end: s1, p_shift_days: [dow] });
    check('admin sets the agent shift', set === null || set === '' || !set?.message, JSON.stringify(set));
    const denied = await rpc(agentJwt, 'update_agent_settings', { p_agent: agentId, p_record_calls: true, p_shift_start: null, p_shift_end: null, p_shift_days: null });
    check('agent cannot change shift/recording settings', denied?.message, JSON.stringify(denied));
    await sql(`update agents set tracking_start = now() - interval '1 day' where id='${agentId}'`); // allow an event from 2 h ago
    const gv2 = `E2ESH${crypto.randomBytes(5).toString('hex')}`;
    await fetch(ING, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': token }, body: JSON.stringify({ parser_version: 'e2e', events: [
      { type: 'text', gv_id: gv2, gv_thread_id: `t.${gv2}`, agent_number: '+15550001111', contact_number: '+15550108888', direction: 'outbound', occurred_at: new Date(Date.now() - 2 * 3600e3).toISOString(), body: 'hi', type_code: 11 },
    ] }) });
    const rep = await rpc(adminJwt, 'shift_report', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
    const r = rep?.[0];
    check('shift report: today\'s shift with first outbound ~60 min late, finished early ~60 min', r && Number(r.late_min) >= 55 && Number(r.late_min) <= 65 && Number(r.early_min) >= 55 && Number(r.early_min) <= 65 && Number(r.outbound) === 1, JSON.stringify(r));
    const si = await rpc(adminJwt, 'shift_issues', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
    const rules = (si || []).map((x) => x.rule);
    check('shift issues: late start + early finish + idle gap flagged', ['shift_late_start', 'shift_early_finish', 'shift_idle_gap'].every((k) => rules.includes(k)), JSON.stringify(rules));
    const ts = await rpc(adminJwt, 'team_stats', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
    check('team stats: in-shift 1 (the text), off-shift = the recorded call, talk time 7 s', ts?.[0] && Number(ts[0].in_shift) === 1 && Number(ts[0].off_shift) >= 1 && Number(ts[0].talk_sec) === 7 && Number(ts[0].recorded) === 1, JSON.stringify(ts?.[0]));
  } else console.log('SKIP  shift checks (test window crosses midnight Pakistan time)');

  const hm = await rpc(adminJwt, 'metrics_heatmap', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
  const tot = (hm || []).reduce((t, x) => t + Number(x.total), 0);
  check('busiest-times grid adds up to all activity today', Array.isArray(hm) && tot >= 2, JSON.stringify(hm).slice(0, 200));
  const hmAgent = await rpc(agentJwt, 'metrics_heatmap', { p_from: todayKey, p_to: todayKey });
  check('agent sees their own busiest-times grid', Array.isArray(hmAgent) && hmAgent.reduce((t, x) => t + Number(x.total), 0) === tot, JSON.stringify(hmAgent).slice(0, 120));
}

async function cleanup() {
  try { created.chrome?.kill(); } catch { /* ignore */ }
  await sleep(800);
  try { if (created.userDir) fs.rmSync(created.userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const id of created.users) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  if (created.agentId) {
    const files = await sql(`select name from storage.objects where bucket_id='recordings' and name like '${created.agentId}/%'`).catch(() => []);
    if (files.length) await fetch(`${URL_}/storage/v1/object/recordings`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: files.map((f) => f.name) }) }).catch(() => {});
    await sql(`delete from agents where id = '${created.agentId}'`).catch(() => {});
  }
  await sql("delete from contacts c where c.phone_e164 like '+155501077%' or c.phone_e164 like '+155501088%'").catch(() => {});
}

try {
  const token = `coco_${crypto.randomBytes(24).toString('hex')}`;
  const [{ id: agentId }] = await sql(`insert into agents (name, token_hash, token_hint, account_type) values ('E2E Recorder', '${crypto.createHash('sha256').update(token).digest('hex')}', '${token.slice(-4)}', 'workspace') returning id`);
  created.agentId = agentId;
  const adminJwt = await mkUser('admin');
  const agentJwt = await mkUser('agent', agentId);
  await browserPart(token, agentId, adminJwt);
  await backendPart(token, agentId, adminJwt, agentJwt);
} catch (e) { check('test run completed without crashing', false, e.stack || String(e)); } finally { await cleanup(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
