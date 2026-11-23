// Virtual end-to-end test: real extension in Chromium + mocked voice.google.com + REAL Supabase.
// Creates throwaway agent/users, runs every flow, verifies extension state + database + dashboard
// security, then deletes everything it created.
//
// Usage: node tests/e2e/run.mjs        (needs .env with SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF)
// Optional: CHROMIUM=<path to chrome.exe> (default: newest Playwright Chromium)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';
import * as F from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'extension');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.SUPABASE_URL;
const ANON = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8').match(/eyJ[^']+/)[0];
const TZ = 'Asia/Karachi';
const PORT = 9333;

// ---------------- helpers ----------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ↳ ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(step);
  }
  return last instanceof Error ? null : last;
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok || j.message) throw new Error(`SQL: ${j.message || r.status}`);
  return j;
}
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const findChromium = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found; set CHROMIUM=');
};

// ---------------- state for cleanup ----------------
const created = { users: [], agentId: null, chrome: null, userDir: null, reviewKeys: [] };
let SR;

async function makeUser(email, role, agentId = null) {
  const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  if (!u.id) throw new Error(`createUser: ${JSON.stringify(u)}`);
  created.users.push(u.id);
  await sql(`insert into profiles (user_id, role, agent_id) values ('${u.id}', '${role}', ${agentId ? `'${agentId}'` : 'null'})`);
  const t = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json();
  return Object.assign(new String(t.access_token), { email, password: pw });
}
const rest = async (jwt, p, body) => {
  const r = await fetch(`${URL_}/rest/v1/${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
};

async function main() {
  // ---------- Supabase fixtures ----------
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
  SR = keys.find((k) => k.name === 'service_role').api_key;
  const token = `coco_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const [{ id: agentId }] = await sql(`insert into agents (name, token_hash, token_hint, account_type) values ('E2E Bot', '${hash}', '${token.slice(-4)}', 'workspace') returning id`);
  created.agentId = agentId;
  const stamp = Date.now();
  const adminUser = await makeUser(`e2e-admin-${stamp}@example.com`, 'admin');
  const adminJwt = String(adminUser);
  const agentJwt = String(await makeUser(`e2e-agentuser-${stamp}@example.com`, 'agent', agentId));
  console.log(`fixtures: agent ${agentId}, 2 temp users\n`);

  // ---------- launch Chromium with the extension ----------
  created.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-e2e-'));
  created.chrome = spawn(findChromium(), [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${created.userDir}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000);
  const cdp = await CDP.connect(PORT);

  const sw = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos
    .find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(t.url)), 20000);
  check('extension loads and its service worker starts', sw, 'no service worker target');
  if (!sw) return;
  const extId = sw.url.split('/')[2];
  let swS = await cdp.attach(sw.targetId);
  let swS2 = null;
  const store = () => cdp.eval(swS2 || swS, 'chrome.storage.local.get(null)');

  // ---------- mock voice.google.com + clients6.google.com ----------
  let threads = [];
  let sendText = null;
  const PAGE = `<!doctype html><html><head><title>mock voice</title></head><body><h1>Mock Google Voice</h1><script>
    setTimeout(async () => {
      const base = 'https://clients6.google.com/voice/v1/voiceclient/';
      await new Promise((res) => { const x = new XMLHttpRequest(); x.open('POST', base + 'account/get?alt=protojson'); x.onload = res; x.onerror = res; x.send('[]'); });
      if (location.hash.startsWith('#send=')) await fetch(base + 'api2thread/sendsms?alt=protojson', { method: 'POST', body: decodeURIComponent(location.hash.slice(6)) });
      await fetch(base + 'api2thread/list?alt=protojson', { method: 'POST', body: '[]' });
      document.title = 'loaded';
    }, 400);
  </script></body></html>`;
  const b64 = (s) => Buffer.from(s).toString('base64');
  const cors = [{ name: 'Access-Control-Allow-Origin', value: 'https://voice.google.com' }, { name: 'Access-Control-Allow-Credentials', value: 'true' }];
  cdp.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const u = request.url;
    let body = '';
    let headers = [{ name: 'Content-Type', value: 'application/json' }, ...cors];
    if (u.startsWith('https://voice.google.com/')) { body = PAGE; headers = [{ name: 'Content-Type', value: 'text/html' }]; }
    else if (/account\/get/.test(u)) body = F.accountBody();
    else if (/api2thread\/list/.test(u)) body = F.listBody(threads);
    else if (/api2thread\/sendsms/.test(u)) body = '[]';
    await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: request.method === 'OPTIONS' ? 204 : 200, responseHeaders: headers, body: b64(body) }, m.sessionId).catch(() => {});
  });
  const { targetId: pageId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const pageS = await cdp.attach(pageId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://voice.google.com/*' }, { urlPattern: 'https://clients6.google.com/*' }] }, pageS);
  await cdp.send('Page.enable', {}, pageS);
  async function loadVoice(hash = '') {
    await cdp.send('Page.navigate', { url: `https://voice.google.com/u/0/messages?e2e=${Date.now()}${hash}` }, pageS);
    const ok = await waitFor(() => cdp.eval(pageS, "document.title === 'loaded'"), 15000);
    await sleep(1500); // let the service worker parse + store
    return ok;
  }

  // ---------- extension pages ----------
  async function openExtPage(p) {
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/${p}` });
    const s = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, s);
    await waitFor(() => cdp.eval(s, "location.protocol === 'chrome-extension:' && document.readyState === 'complete'"), 15000);
    return s;
  }
  let optS = await openExtPage('options/options.html');
  const syncNow = () => cdp.eval(optS, "chrome.runtime.sendMessage({ type: 'sync-now' })");

  // ===== 1. Connect with token only =====
  await cdp.eval(optS, "document.getElementById('agentToken').value = 'not-a-token'; document.getElementById('connect').click(); true");
  const badMsg = await waitFor(async () => { const t = await cdp.eval(optS, "document.getElementById('msg').textContent"); return /✗|✓/.test(t) && t; }, 15000);
  const badNow = await cdp.eval(optS, "document.getElementById('msg').textContent");
  check('connect: malformed token is rejected with a clear message', /doesn't look like a Coco token/.test(badMsg || ''), `shown: "${badNow}"`);
  const connectAt = Date.now();
  await cdp.eval(optS, `document.getElementById('agentToken').value = '${token}'; document.getElementById('connect').click(); true`);
  const okMsg = await waitFor(async () => { const t = await cdp.eval(optS, "document.getElementById('msg').textContent"); return /Connected|✗/.test(t) && t; }, 20000);
  check('connect: valid token shows "Connected as E2E Bot"', /Connected as E2E Bot/.test(okMsg || ''), okMsg);
  const [{ tracking_start: ts0 }] = await sql(`select tracking_start from agents where id = '${agentId}'`);
  check('tracking starts at the moment of connecting (no old history)', ts0 && Math.abs(Date.parse(ts0) - connectAt) < 60e3, `${ts0} vs ${new Date(connectAt).toISOString()}`);

  // ===== 2. Capture a normal session =====
  const sessionEnd = Date.now() + 60 * 60e3;
  const sc = F.scenario(sessionEnd, connectAt); // session happens after connecting
  threads = sc.threads;
  check('mock Voice page loads (fetch + XHR intercepted)', await loadVoice());
  const widget = await cdp.eval(pageS, "!!document.getElementById('coco-voice-widget')");
  check('left mini-tracker widget is injected on the Voice page', widget);
  let st = await store();
  check('agent Voice number auto-detected from account/get', st.agentNumber === F.AGENT, st.agentNumber);
  const s1 = st.summaryToday || {};
  for (const k of ['outboundTotal', 'inboundTotal', 'contactsReached', 'outboundCalls', 'connectedCalls', 'outboundTexts', 'inboundCalls', 'missedCalls', 'inboundTexts', 'voicemails']) {
    check(`panel/badge summary: ${k} = ${sc.expect[k]}`, s1[k] === sc.expect[k], `got ${s1[k]}`);
  }
  check('event from 3 days ago is ignored', !Object.values(st.events || {}).some((e) => e.c === F.C));
  check('event 10 min BEFORE connecting is ignored (no old history)', !Object.values(st.events || {}).some((e) => e.c === F.H));
  check('unknown type code counted as unclassified locally', (st.health?.unknown || 0) >= 1, JSON.stringify(st.health));
  const badge = await cdp.eval(swS, 'chrome.action.getBadgeText({})');
  check(`toolbar badge shows today's outbound total (${sc.expect.outboundTotal})`, badge === String(sc.expect.outboundTotal), `badge "${badge}"`);

  await syncNow();
  st = await waitFor(async () => { const x = await store(); return (x.queue || []).length === 0 && x.lastSyncAt && x; }, 20000);
  check('queue fully synced to Supabase', st && !st.lastSyncError, st?.lastSyncError);
  const db1 = (await sql(`select (select count(*) from messages where agent_id='${agentId}') m, (select count(*) from calls where agent_id='${agentId}') c,
    (select count(*) from unclassified_events where agent_id='${agentId}') u, (select count(*) from raw_events where agent_id='${agentId}') r,
    (select count(*) from messages where agent_id='${agentId}' and kind='voicemail' and body like 'Hi, please call%') vm,
    (select count(*) from calls where agent_id='${agentId}' and direction='outbound' and outcome='connected' and duration_sec=125) cout,
    (select count(*) from calls where agent_id='${agentId}' and direction='inbound' and outcome='missed') cmiss,
    (select gv_number from agents where id='${agentId}') num`))[0];
  check(`DB: ${sc.expect.dbMessages} messages (texts + voicemail)`, Number(db1.m) === sc.expect.dbMessages, `got ${db1.m}`);
  check(`DB: ${sc.expect.dbCalls} calls`, Number(db1.c) === sc.expect.dbCalls, `got ${db1.c}`);
  check('DB: unknown item stored in unclassified_events', Number(db1.u) === sc.expect.unclassified, `got ${db1.u}`);
  check('DB: voicemail transcript stored', Number(db1.vm) === 1);
  check('DB: outbound call picked up (connected) with duration 125 s', Number(db1.cout) === 1);
  check('DB: inbound missed call', Number(db1.cmiss) === 1);
  check('DB: agent Voice number saved', db1.num === F.AGENT, db1.num);
  const [{ h }] = await sql(`select last_health h from agents where id='${agentId}'`);
  check('diagnostics reach the dashboard (version, captures since page load, status)', h && /^\d+\.\d+\.\d+$/.test(h.extensionVersion || '') && h.capturesSinceLoad > 0 && !!h.status && Object.keys(h.net || {}).some((k) => k.includes('voiceclient')), JSON.stringify(h).slice(0, 220));
  const st1 = await store();
  check('panel/badge use the server numbers after sync (same as dashboard)', st1.serverSummary?.today?.outboundTotal === sc.expect.outboundTotal, JSON.stringify(st1.serverSummary?.today));

  // ===== 3. Reload = no duplicates =====
  await loadVoice();
  await syncNow();
  await sleep(2500);
  const db2 = (await sql(`select (select count(*) from messages where agent_id='${agentId}') m, (select count(*) from calls where agent_id='${agentId}') c, (select count(*) from raw_events where agent_id='${agentId}') r`))[0];
  check('reloading Voice creates no duplicates (DB + nothing re-sent)', db2.m === db1.m && db2.c === db1.c && db2.r === db1.r, JSON.stringify({ before: db1, after: db2 }));

  // ===== 4. Sent-text self-check =====
  const now5 = Date.now();
  threads = [...sc.threads, F.thread(`t.${F.A}`, [F.msg({ tag: 'a5', at: now5, phone: F.A, type: 11, text: 'Following up!', thread: `t.${F.A}` })])];
  await loadVoice(`#send=${encodeURIComponent(F.sendSmsBody('Following up!', F.A))}`);
  st = await store();
  const chk = (st.health?.sendChecks || []).at(-1);
  check('sent-text self-check: outgoing SMS request matched by a parsed outbound text', chk?.matched === true, JSON.stringify(chk));
  check('another text to A counts again (every text counts; contacts stay 2)', st.summaryToday?.outboundTotal === sc.expect.outboundTotal + 1 && st.summaryToday?.contactsReached === 2, JSON.stringify(st.summaryToday));

  // ===== 5. Side panel UI =====
  await syncNow();
  await sleep(1500);
  const panelS = await openExtPage('popup/popup.html');
  await sleep(800);
  const panel = await cdp.eval(panelS, `({ status: document.getElementById('statusText').textContent, who: document.getElementById('who').textContent,
    outTotal: document.getElementById('outboundTotal').textContent, textsOut: document.getElementById('outboundTexts').textContent,
    pause: document.getElementById('pause').textContent })`);
  check('side panel shows "Tracking" + "Connected as E2E Bot"', panel.status === 'Tracking' && /Connected as E2E Bot/.test(panel.who), JSON.stringify(panel));
  const src = await cdp.eval(panelS, "document.getElementById('statusSub').textContent");
  check('side panel says its numbers come from the dashboard', /from dashboard/.test(src), src);
  check('side panel numbers match (outbound total, texts out)', panel.outTotal === String(sc.expect.outboundTotal + 1) && panel.textsOut === String(sc.expect.outboundTexts + 1), JSON.stringify(panel));

  // ===== 6. Pause / resume =====
  cdp.on((m) => { if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === panelS) cdp.send('Page.handleJavaScriptDialog', { accept: true }, panelS); });
  await cdp.eval(panelS, "document.getElementById('pause').click(); true");
  st = await waitFor(async () => { const x = await store(); return x.paused && x; }, 5000);
  check('Pause (with confirmation) sets paused state', st?.paused === true);
  check('badge shows II while paused', (await cdp.eval(swS2 || swS, 'chrome.action.getBadgeText({})')) === 'II');
  threads = [...threads, F.scenarioPaused(Date.now() + 70 * 60e3)];
  await loadVoice();
  st = await store();
  check('while paused, new Voice activity is NOT captured', !Object.values(st.events || {}).some((e) => e.c === F.E));
  await syncNow();
  await sleep(2000);
  const [{ p: pausedFlag }] = await sql(`select (last_health->>'paused') p from agents where id='${agentId}'`);
  check('dashboard sees the agent as paused (heartbeat health)', pausedFlag === 'true', pausedFlag);
  await cdp.eval(panelS, "document.getElementById('pause').click(); true");
  st = await waitFor(async () => { const x = await store(); return x.paused === false && x; }, 5000);
  check('Resume clears paused state', st?.paused === false);
  await loadVoice();
  st = await store();
  check('after resume, activity from the pause is picked up from Voice history', Object.values(st.events || {}).some((e) => e.c === F.E));
  await syncNow();
  await sleep(2500);

  // ===== 7. Dashboard metrics + security (real RPCs with real user JWTs) =====
  const [m] = await rest(adminJwt, 'rpc/metrics_summary', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
  const want = { outbound_total: 5, inbound_total: 5, contacts_reached: 2, outbound_calls: 1, connected_calls: 1, outbound_texts: 4, inbound_calls: 2, missed_calls: 1, inbound_texts: 2, voicemails: 1, unclassified: 1 };
  for (const [k, v] of Object.entries(want)) check(`dashboard metrics_summary.${k} = ${v}`, Number(m?.[k]) === v, `got ${m?.[k]}`);
  check('dashboard reply rate = 50% (A replied, group contact did not)', Number(m?.response_rate) === 50, `got ${m?.response_rate}`);
  check('dashboard avg reply time = 5 min (A texted, agent called 5 min later)', Number(m?.avg_reply_min) === 5, `got ${m?.avg_reply_min}`);
  const daily = await rest(adminJwt, 'rpc/metrics_daily', { p_from: todayKey, p_to: todayKey, p_agent: agentId });
  check('dashboard daily trend row for today (outbound 5, inbound 5)', Number(daily?.[0]?.outbound_total) === 5 && Number(daily?.[0]?.inbound_total) === 5, JSON.stringify(daily));
  const contacts = await rest(adminJwt, 'rpc/contact_activity', { p_from: todayKey, p_to: todayKey, p_agent: agentId, p_search: null });
  const cA = (contacts || []).find((c) => c.contact === F.A);
  check('contacts: one row per contact (A, B, D, G1, E)', Array.isArray(contacts) && contacts.length === 5, `got ${contacts?.length}`);
  check('contacts: A has every call and text under it (1 call out, 3 texts out, 1 text in = 5)', cA && Number(cA.calls_out) === 1 && Number(cA.texts_out) === 3 && Number(cA.texts_in) === 1 && Number(cA.total) === 5, JSON.stringify(cA));
  const convs = await rest(adminJwt, 'rpc/conversation_list', { p_from: todayKey, p_to: todayKey, p_agent: agentId, p_search: null });
  check('manager/admin sees conversations list', Array.isArray(convs) && convs.length >= 4, `got ${convs?.length}`);
  const search = await rest(adminJwt, 'rpc/conversation_list', { p_from: todayKey, p_to: todayKey, p_agent: agentId, p_search: 'Booked' });
  check('conversation search by message text works', Array.isArray(search) && search.length === 1, `got ${search?.length}`);
  const agentMsgs = await rest(agentJwt, `messages?select=id&agent_id=eq.${agentId}`);
  check('agent-role user CANNOT read message transcripts (RLS)', Array.isArray(agentMsgs) && agentMsgs.length === 0, JSON.stringify(agentMsgs).slice(0, 120));
  const agentConvs = await rest(agentJwt, 'rpc/conversation_list', { p_from: todayKey, p_to: todayKey, p_agent: null, p_search: null });
  check('agent-role user gets no conversation list', Array.isArray(agentConvs) && agentConvs.length === 0);
  const agentMetrics = await rest(agentJwt, 'rpc/metrics_summary', { p_from: todayKey, p_to: todayKey, p_agent: null });
  check('agent-role user sees only their own metrics row (own numbers)', Array.isArray(agentMetrics) && agentMetrics.length === 1 && agentMetrics[0].agent_id === agentId && Number(agentMetrics[0].outbound_total) === 5, JSON.stringify(agentMetrics).slice(0, 160));
  const agentContacts = await rest(agentJwt, 'rpc/contact_activity', { p_from: todayKey, p_to: todayKey, p_agent: null, p_search: null });
  check('agent-role user cannot see the contacts list (admin only)', Array.isArray(agentContacts) && agentContacts.length === 0);
  const anonMsgs = await rest(ANON, `messages?select=id&agent_id=eq.${agentId}`);
  check('anonymous visitor reads nothing', Array.isArray(anonMsgs) && anonMsgs.length === 0);


  // ===== 7a. Rule-based analysis (DB functions) + admin review =====
  const later = new Date(Date.now() + 4 * 864e5).toISOString(); // evaluate "pending" rules as if 4 days passed
  const toKey2 = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + 864e5));
  const anArgs = { p_from: todayKey, p_to: toKey2, p_agent: agentId, p_now: later };
  let issues = await rest(adminJwt, 'rpc/analysis_issues', anArgs);
  const byRule = (rule, contact) => (issues || []).filter((i) => i.rule === rule && (!contact || i.contact === contact));
  check('analysis: missed call + voicemail from B = ONE "missed call not returned" (high)', byRule('missed_call_not_returned', F.B).length === 1 && byRule('missed_call_not_returned', F.B)[0].severity === 'high', JSON.stringify(byRule('missed_call_not_returned')));
  check('analysis: answered call from D is not flagged', byRule('missed_call_not_returned', F.D).length === 0);
  check('analysis: A\'s text answered in 5 min is not flagged', byRule('text_not_answered', F.A).length === 0, JSON.stringify(byRule('text_not_answered', F.A)));
  check('analysis: E\'s text never answered = high', byRule('text_not_answered', F.E).length === 1 && byRule('text_not_answered', F.E)[0].severity === 'high');
  check('analysis: single unanswered attempt to G1 = "no follow-up"', byRule('no_follow_up', F.G1).length === 1);
  check('analysis: A (replied) not flagged for follow-up / over-contacting', byRule('no_follow_up', F.A).length === 0 && byRule('over_contacting', F.A).length === 0);
  const nowIssues = await rest(adminJwt, 'rpc/analysis_issues', { ...anArgs, p_now: new Date().toISOString() });
  check('analysis: fresh items are not flagged before their deadline', !(nowIssues || []).some((i) => i.rule === 'no_follow_up'));

  // inject opt-out, over-contacting and short-call cases through the real ingest function (SQL)
  const ev = (id, contact, type, direction, atMin, extra = {}) => ({
    type, gv_id: `e2ean${id}${'0'.repeat(30)}`.slice(0, 40), gv_thread_id: `t.${contact}`, contact_number: contact, direction,
    occurred_at: new Date(sessionEnd + atMin * 60e3).toISOString(), body: null, call_outcome: null, duration_sec: 0, ...extra });
  const OPT = '+15550100008'; const OVER = '+15550100009'; const SHORT = '+15550100010';
  const extra = [
    ev('f1', OPT, 'text', 'inbound', 80, { body: 'STOP' }),
    ev('f2', OPT, 'text', 'outbound', 90, { body: 'Sorry to bother you, one more thing…' }),
    ev('k1', OVER, 'text', 'outbound', 100, { body: 'Hi' }), ev('k2', OVER, 'text', 'outbound', 101, { body: 'Hello?' }),
    ev('k3', OVER, 'text', 'outbound', 102, { body: 'Are you there?' }), ev('k4', OVER, 'call', 'outbound', 103),
    ev('s1', SHORT, 'call', 'outbound', 110, { call_outcome: 'answered', duration_sec: 5 }),
  ];
  await sql(`select ingest_batch('${agentId}', null, 'e2e', $e2e$${JSON.stringify(extra)}$e2e$::jsonb, null)`);
  issues = await rest(adminJwt, 'rpc/analysis_issues', anArgs);
  check('analysis: contacting a customer after "STOP" = opt-out ignored (high)', byRule('opt_out_ignored', OPT).length === 1 && byRule('opt_out_ignored', OPT)[0].severity === 'high', JSON.stringify(byRule('opt_out_ignored')));
  check('analysis: 4 unanswered attempts in a day = over-contacting', byRule('over_contacting', OVER).length === 1);
  check('analysis: 5-second connected call = very short call', byRule('very_short_call', SHORT).length === 1);

  const card0 = (await rest(adminJwt, 'rpc/analysis_scorecard', anArgs))?.[0];
  check('scorecard: score + reply/return metrics computed', card0 && card0.score < 100 && Number(card0.customer_texts) === 3 && Number(card0.missed_calls) === 1 && Number(card0.opt_out_violations) === 1, JSON.stringify(card0));

  // admin review: dismiss one issue -> status shows, score goes up, reopen works
  const target = byRule('no_follow_up', F.G1)[0];
  created.reviewKeys.push(target.issue_key);
  const up = await fetch(`${URL_}/rest/v1/analysis_reviews`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ issue_key: target.issue_key, status: 'dismissed', note: 'e2e: customer asked to wait' }) });
  check('admin can dismiss an issue with a note', up.ok, `${up.status} ${await up.text()}`);
  issues = await rest(adminJwt, 'rpc/analysis_issues', anArgs);
  const after = byRule('no_follow_up', F.G1)[0];
  check('dismissed issue shows status, note and reviewer', after?.status === 'dismissed' && after?.note === 'e2e: customer asked to wait' && /e2e-admin-/.test(after?.reviewed_by || ''), JSON.stringify(after));
  const card1 = (await rest(adminJwt, 'rpc/analysis_scorecard', anArgs))?.[0];
  check('dismissed issue no longer lowers the score (+1 for a low issue)', card1 && card1.score === card0.score + 1, `${card0?.score} -> ${card1?.score}`);
  const agentIssues = await rest(agentJwt, 'rpc/analysis_issues', anArgs);
  const agentReviews = await rest(agentJwt, 'analysis_reviews?select=issue_key');
  check('agent-role user cannot see analysis or reviews (admin only)', Array.isArray(agentIssues) && agentIssues.length === 0 && Array.isArray(agentReviews) && agentReviews.length === 0);

  // ===== 7b. Live dashboard UI (Vercel) signed in as the temp admin =====
  const { targetId: dashId } = await cdp.send('Target.createTarget', { url: 'https://coco-voice-dashboard.vercel.app/' });
  const dS = await cdp.attach(dashId);
  await waitFor(() => cdp.eval(dS, "!!document.getElementById('pwForm') && document.readyState === 'complete'"), 20000);
  await cdp.eval(dS, `document.getElementById('email').value = ${JSON.stringify(adminUser.email)};
    document.getElementById('password').value = ${JSON.stringify(adminUser.password)};
    document.querySelector('#pwForm button[type=submit]').click(); true`);
  const loggedIn = await waitFor(() => cdp.eval(dS, "!document.getElementById('app').hidden && document.getElementById('login').hidden && !!document.querySelector('.kpis')"), 20000);
  check('dashboard: password sign-in opens the app (login card hidden)', loggedIn);
  await cdp.eval(dS, `(() => { const s = document.getElementById('agentFilter'); s.value = '${agentId}'; s.dispatchEvent(new Event('change')); document.querySelector('#range [data-r=today]').click(); return true; })()`);
  await sleep(3000);
  const tiles = await cdp.eval(dS, "[...document.querySelectorAll('.kpis .kpi')].map((k) => [k.querySelector('.label').textContent.trim(), k.querySelector('.value').textContent.trim()])");
  const tile = Object.fromEntries(tiles || []);
  // session (5 out / 5 in) + analysis cases (6 out: 1 text after STOP, 3 texts + 1 call over-contact, 1 short call; 1 in: STOP)
  check('dashboard UI tiles: outbound 11, calls out 3, texts out 8, inbound 6, calls in 2, texts in 3',
    tile.Outbound === '11' && tile['Calls out'] === '3' && tile['Texts out'] === '8' && tile.Inbound === '6' && tile['Calls in'] === '2' && tile['Texts in'] === '3', JSON.stringify(tile));
  const callsInRed = await cdp.eval(dS, "[...document.querySelectorAll('.kpis .kpi')].find((k) => k.textContent.includes('Calls in'))?.classList.contains('r')");
  check('dashboard UI: "Calls in" tile is red when calls were missed', callsInRed === true);
  const insightText = await cdp.eval(dS, "document.querySelector('.insights')?.textContent || ''");
  check('dashboard UI: analysis panel mentions the missed call', /missed/.test(insightText), insightText.slice(0, 160));
  const agentRow = await cdp.eval(dS, "[...document.querySelectorAll('tbody tr')].map((r) => r.textContent).find((t) => t.includes('E2E Bot')) || ''");
  check('dashboard UI: agents table shows E2E Bot as Tracking', /Tracking/.test(agentRow), agentRow.replace(/\s+/g, ' ').slice(0, 200));
  await cdp.eval(dS, "location.hash = '#/contacts'; true");
  const contactRows = await waitFor(() => cdp.eval(dS, "document.querySelectorAll('#ctable tbody tr.click').length"), 10000);
  check('dashboard UI: Contacts page lists every contact (5 + 3 analysis cases)', contactRows === 8, `got ${contactRows}`);
  await cdp.eval(dS, "location.hash = '#/analysis'; true");
  const anRows = await waitFor(() => cdp.eval(dS, "document.querySelectorAll('tr[data-key]').length"), 15000);
  check('dashboard UI: Analysis page lists issues with Reviewed / Dismiss buttons', anRows >= 1 && await cdp.eval(dS, "!!document.querySelector('.aRev') && !!document.querySelector('.aDis')"), `rows ${anRows}`);
  const navText = await cdp.eval(dS, "document.getElementById('navLinks').textContent");
  check('dashboard UI: Contacts + Analysis in nav, no Claude/Reports page', !/Reports|coaching/i.test(navText) && /Contacts/.test(navText) && /Analysis/.test(navText), navText);
  await cdp.eval(dS, "location.hash = '#/conversations'; true");
  const convItems = await waitFor(() => cdp.eval(dS, "document.querySelectorAll('#clist .item').length"), 10000);
  check('dashboard UI: conversations page lists threads', convItems >= 4, `got ${convItems}`);
  await cdp.eval(dS, "document.querySelector('#clist .item').click(); true");
  const bubbles = await waitFor(() => cdp.eval(dS, "document.querySelectorAll('#detail .bubble, #detail .callrow, #detail .event').length"), 10000);
  check('dashboard UI: opening a conversation shows the timeline', bubbles >= 1, `got ${bubbles}`);
  await cdp.eval(dS, "location.hash = '#/settings'; true");
  const settingsOk = await waitFor(() => cdp.eval(dS, "!!document.getElementById('createUser') && !!document.getElementById('saveSettings') && document.body.textContent.includes('E2E Bot')"), 10000);
  check('dashboard UI: admin Settings shows Create user, business settings and the agent', settingsOk);

  // ===== 8. Revoked token =====
  await sql(`update agents set token_hash = 'revoked-${crypto.randomBytes(4).toString('hex')}' where id='${agentId}'`);
  await cdp.eval(swS2 || swS, "chrome.storage.local.set({ heartbeatPending: true, backoffUntil: 0 })");
  await syncNow();
  st = await waitFor(async () => { const x = await store(); return x.lastSyncError && x; }, 10000);
  check('revoked token -> clear "Token rejected" error in the extension', /Token rejected/.test(st?.lastSyncError || ''), st?.lastSyncError);
  check('status turns red on sync error', st?.status?.level === 'bad', JSON.stringify(st?.status));

  cdp.close();
}

async function cleanup() {
  try { created.chrome?.kill(); } catch { /* ignore */ }
  await sleep(800);
  try { if (created.userDir) fs.rmSync(created.userDir, { recursive: true, force: true }); } catch { /* locked files: harmless temp dir */ }
  for (const id of created.users) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  if (created.reviewKeys.length) await sql(`delete from analysis_reviews where issue_key in (${created.reviewKeys.map((k) => `'${k}'`).join(',')})`).catch(() => {});
  if (created.agentId) await sql(`delete from agents where id = '${created.agentId}'`).catch(() => {});
  await sql("delete from contacts c where c.phone_e164 like '+155501000%' and not exists (select 1 from conversations v where v.contact_id = c.id)").catch(() => {});
  const [left] = await sql("select (select count(*) from agents where name='E2E Bot') agents, (select count(*) from auth.users where email like 'e2e-%@example.com') users, (select count(*) from contacts where phone_e164 like '+155501000%') contacts");
  console.log(`\ncleanup: ${JSON.stringify(left)}`);
}

try { await main(); } catch (e) { check('test run completed without crashing', false, e.stack || String(e)); } finally { await cleanup(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
process.exit(failed.length ? 1 : 0);
