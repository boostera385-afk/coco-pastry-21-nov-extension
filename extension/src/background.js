// Service worker: parse -> filter (from the moment the agent connected; no old history) -> dedupe -> queue -> sync.
// Also owns the shared status (badge, side panel, in-page widget) and pause/resume.
import { parseResponse, parseSendRequest, PARSER_VERSION } from './parser/gv-protojson.js';
import { DEFAULT_TZ, summarize, dayKey } from './lib/metrics.js';
import { INGEST_URL, TOKEN_RE } from './config.js';

const KEEP_DAYS = 35;          // local history for the panel
const BATCH = 100;
const MAX_SAMPLES = 25;        // Phase 0 sample recorder
const TAB_STALE_MS = 11 * 60e3; // no heartbeat for this long = no Voice tab open
const VOICE_URL = 'https://voice.google.com/';

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// All read-modify-write of events/queue goes through this chain (no lost updates).
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

// ---------- lifecycle ----------
function setup() {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshStatus();
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Nothing is tracked until the agent connects their token (that moment = tracking start).
    await set({
      trackingStart: null,
      installedAt: Date.now(),
      timezone: DEFAULT_TZ,
      paused: false,
      showWidget: true,
      events: {}, queue: [], health: { captures: 0, parsed: 0, unknown: 0, sendChecks: [] },
    });
  }
  setup();
  injectIntoOpenVoiceTabs();
});
chrome.runtime.onStartup.addListener(setup);

/** Content scripts only auto-inject on page load; cover Voice tabs that were already open. */
async function injectIntoOpenVoiceTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://voice.google.com/*' });
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/interceptor.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content.js', 'src/widget.js'] });
    } catch { /* tab discarded or not ready: it gets scripts on next load */ }
  }
}

// ---------- messages from content script / panel / widget / options ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'gv-capture': await serial(() => onCapture(msg)); break;
      case 'heartbeat': await set({ lastHeartbeat: Date.now(), heartbeatPending: true }); await refreshStatus(); break;
      case 'sync-now': return reply(await sync());
      case 'set-paused': await setPaused(!!msg.paused); break;
      case 'connect': return reply(await connect(msg.token));
      case 'disconnect':
        await set({ agentToken: null, agentName: null, lastSyncError: null, failures: 0, backoffUntil: 0 });
        await refreshStatus();
        break;
      case 'open-voice': await openVoice(); break;
      case 'reset-local': await serial(() => set({ events: {}, queue: [] })); break;
      default: break;
    }
    reply({ ok: true });
  })().catch((e) => reply({ ok: false, error: String(e) }));
  return true;
});

async function setPaused(paused) {
  const { health = {} } = await get('health');
  health.paused = paused;
  health.pausedAt = paused ? new Date().toISOString() : null;
  await set({ paused, pausedAt: paused ? Date.now() : null, health, heartbeatPending: true });
  await refreshStatus();
  sync(); // tell the dashboard right away
}

/** Save the agent's token and verify it against the server right away. */
async function connect(raw) {
  const token = String(raw || '').trim();
  if (!TOKEN_RE.test(token)) return { ok: false, error: 'That doesn\'t look like a Coco token (it starts with coco_).' };
  const prev = await get(['agentToken']);
  if (token !== prev.agentToken) {
    // New connection = start working now. Drop anything seen before (no old history).
    // If this agent already started on another computer, the server sends back its original start time.
    await serial(() => set({ trackingStart: Date.now(), events: {}, queue: [], health: { captures: 0, parsed: 0, unknown: 0, sendChecks: [] } }));
  }
  await set({ agentToken: token, agentName: null, backoffUntil: 0, failures: 0, heartbeatPending: true, lastSyncError: null });
  const r = await sync();
  if (!r.ok) {
    if (/Token rejected/.test(r.error)) await set({ agentToken: prev.agentToken || null, lastSyncError: null });
    await refreshStatus();
    return r;
  }
  const { agentName } = await get('agentName');
  await refreshStatus();
  return { ok: true, agentName };
}

async function openVoice() {
  const [tab] = await chrome.tabs.query({ url: 'https://voice.google.com/*' });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: VOICE_URL, pinned: true });
  }
}

// ---------- capture ----------
async function onCapture({ url, body, reqBody }) {
  const st = await get(['agentNumber', 'trackingStart', 'events', 'queue', 'health', 'debugRecord', 'samples', 'paused', 'agentToken']);
  if (st.paused) return; // paused by the agent: capture nothing (reported to the dashboard)
  if (!st.agentToken || !st.trackingStart) return; // not connected yet: tracking hasn't started
  const health = st.health || { captures: 0, parsed: 0, unknown: 0, sendChecks: [] };
  health.captures++;
  health.lastCaptureAt = Date.now();

  if (st.debugRecord) {
    const samples = (st.samples || []).slice(-(MAX_SAMPLES - 1));
    samples.push({ url, at: Date.now(), body: body.slice(0, 200000), reqBody });
    await set({ samples });
  }

  // Self-check: every text the agent sends should show up as a parsed outbound text.
  const sent = parseSendRequest(url, reqBody, { agentNumber: st.agentNumber });
  if (sent) {
    health.sendChecks = [...(health.sendChecks || []).slice(-19), { ...sent, text: undefined, matched: false }];
    await set({ health });
    return;
  }

  const { events, agentNumber } = parseResponse(url, body, { agentNumber: st.agentNumber });
  if (agentNumber && agentNumber !== st.agentNumber) await set({ agentNumber });

  const local = st.events || {};
  const queue = st.queue || [];
  const since = st.trackingStart || 0;
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  let added = 0;

  for (const e of events) {
    const at = Date.parse(e.occurred_at);
    if (!Number.isFinite(at) || at < since) continue;        // only from the moment tracking started
    const sig = `${e.type}|${e.direction}|${e.call_outcome}|${e.duration_sec}|${(e.body || '').length}`;
    const prev = local[e.gv_id];
    if (prev && prev.sig === sig) continue;                  // already have this exact version
    local[e.gv_id] = {
      k: e.type, d: e.direction === 'outbound' ? 'out' : e.direction === 'inbound' ? 'in' : '?',
      c: e.contact_number, at, o: e.call_outcome, s: e.duration_sec, sig,
    };
    queue.push(e);
    added++;
    health.parsed++;
    if (e.type === 'unknown') health.unknown++;
    for (const chk of health.sendChecks || []) {
      if (!chk.matched && e.type === 'text' && e.direction === 'outbound'
          && e.contact_number === chk.contact && Math.abs(at - chk.at) < 5 * 60e3) chk.matched = true;
    }
  }
  for (const [id, v] of Object.entries(local)) if (v.at < cutoff) delete local[id];

  await set({ events: local, queue, health });
  if (added) await refreshStatus();
  if (queue.length >= 50) sync();
}

// ---------- shared status: badge + summary for panel and widget ----------
async function refreshStatus() {
  const st = await get(['events', 'timezone', 'agentToken', 'lastHeartbeat', 'lastSyncError', 'queue', 'paused', 'lastSyncAt']);
  const tz = st.timezone || DEFAULT_TZ;
  const today = dayKey(Date.now(), tz);
  const summary = summarize(Object.values(st.events || {}), today, today, tz);

  let level = 'ok';
  let text = 'Tracking';
  if (!st.agentToken) { level = 'bad'; text = 'Not connected — paste your token in Settings'; }
  else if (st.paused) { level = 'paused'; text = 'Paused'; }
  else if (!st.lastHeartbeat || Date.now() - st.lastHeartbeat > TAB_STALE_MS) { level = 'warn'; text = 'Open Google Voice to track'; }
  else if (st.lastSyncError) { level = 'bad'; text = 'Sync error — retrying'; }
  else if ((st.queue || []).length) { level = 'warn'; text = `${st.queue.length} waiting to sync`; }

  await set({ status: { level, text, at: Date.now() }, summaryToday: summary });

  const colors = { ok: '#00843d', warn: '#ffba00', bad: '#cc3433', paused: '#777777' };
  await chrome.action.setBadgeBackgroundColor({ color: colors[level] });
  await chrome.action.setBadgeTextColor?.({ color: level === 'warn' ? '#000000' : '#ffffff' });
  await chrome.action.setBadgeText({ text: level === 'paused' ? 'II' : level === 'bad' ? '!' : String(summary.outboundTotal || '') });
  await chrome.action.setTitle({ title: `Coco Voice — ${text} · ${summary.outboundTotal} outbound today` });
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.agentToken || c.lastSyncError || c.timezone || c.trackingStart)) refreshStatus();
});

// ---------- sync ----------
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'sync') return;
  await sync();
  await refreshStatus();
});

let syncing = false;
async function sync() {
  if (syncing) return { ok: false, error: 'busy' };
  syncing = true;
  try {
    const st = await get(['agentToken', 'queue', 'agentNumber', 'heartbeatPending', 'health', 'backoffUntil', 'trackingStart']);
    if (!st.agentToken) return { ok: false, error: 'Not connected' };
    if (st.backoffUntil && Date.now() < st.backoffUntil) return { ok: false, error: 'Waiting to retry' };
    if (!(st.queue || []).length && !st.heartbeatPending) return { ok: true, sent: 0 };

    let sent = 0;
    let batch;
    do {
      batch = ((await get('queue')).queue || []).slice(0, BATCH);
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': st.agentToken },
        body: JSON.stringify({
          parser_version: PARSER_VERSION,
          agent_number: st.agentNumber || null,
          tracking_start: st.trackingStart ? new Date(st.trackingStart).toISOString() : null,
          heartbeat: { at: new Date().toISOString(), health: { ...st.health, sendChecks: undefined } },
          events: batch,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) throw new Error('Token rejected — ask your manager for a new token');
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const out = await res.json();
      if (out.agent?.name) await set({ agentName: out.agent.name });
      if (out.config) {
        const upd = { timezone: out.config.timezone };
        if (out.config.tracking_start) upd.trackingStart = Date.parse(out.config.tracking_start);
        await set(upd);
      }
      const n = batch.length;
      await serial(async () => {
        const { queue = [] } = await get('queue');
        await set({ queue: queue.slice(n), heartbeatPending: false });
      });
      sent += n;
    } while (batch.length === BATCH);

    await set({ lastSyncAt: Date.now(), lastSyncError: null, failures: 0, backoffUntil: 0 });
    await refreshStatus(); // status/badge reflect the empty queue right away
    return { ok: true, sent };
  } catch (e) {
    const { failures = 0 } = await get('failures');
    const wait = Math.min(30 * 60e3, 60e3 * 2 ** failures);
    const message = e.name === 'TimeoutError' ? 'Server did not respond' : e instanceof TypeError ? 'No internet connection' : String(e.message || e);
    await set({ lastSyncError: message, failures: failures + 1, backoffUntil: Date.now() + wait });
    return { ok: false, error: message };
  } finally {
    syncing = false;
  }
}
