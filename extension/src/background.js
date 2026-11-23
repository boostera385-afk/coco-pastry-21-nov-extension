// Service worker: parse -> filter (from the moment the agent connected; no old history) -> dedupe -> queue -> sync.
// Also owns the shared status (badge, side panel, in-page widget) and pause/resume.
import { parseResponse, parseSendRequest, PARSER_VERSION } from './parser/gv-protojson.js';
import { DEFAULT_TZ, summarize, dayKey } from './lib/metrics.js';
import { INGEST_URL, TOKEN_RE } from './config.js';

const KEEP_DAYS = 35;          // local history for the panel
const BATCH = 100;
const MAX_SAMPLES = 60;        // sample recorder (Settings → Record samples)
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
  const open = await chrome.tabs.query({ url: 'https://voice.google.com/*' });
  // Already-open Voice tabs keep the OLD page hooks until they are reloaded: say so clearly.
  await set({ needsVoiceReload: open.length > 0 });
  injectIntoOpenVoiceTabs();
});
chrome.runtime.onStartup.addListener(setup);

/** Local cache is only a fallback; drop it when the parser changes (server counts are the truth). */
async function invalidateCacheOnParserChange() {
  const { parserVersion } = await get('parserVersion');
  if (parserVersion !== PARSER_VERSION) {
    await serial(() => set({ events: {}, parserVersion: PARSER_VERSION, heartbeatPending: true }));
  }
}
invalidateCacheOnParserChange();

// ---------- network census (observe only): which Google endpoints the Voice page really calls ----------
// Explains "no data" situations: if Voice calls APIs we can't read, the dashboard shows exactly which.
const API_RE = /voiceclient|\/voice\/v\d|\$rpc\/|batchexecute|\/v1\/voice/i;
let netBuf = {};
let netFlush = null;
// Requests may come from the page, its workers, or helper iframes (e.g. clients6 proxy) inside a Voice tab.
const voiceTabs = new Set();
chrome.tabs.onUpdated.addListener((id, _c, tab) => { if (tab.url?.startsWith('https://voice.google.com/')) voiceTabs.add(id); else voiceTabs.delete(id); });
chrome.tabs.onRemoved.addListener((id) => voiceTabs.delete(id));
chrome.tabs.query({ url: 'https://voice.google.com/*' }).then((ts) => ts.forEach((t) => voiceTabs.add(t.id))).catch(() => {});
const SKIP_TYPES = new Set(['image', 'stylesheet', 'font', 'script', 'media', 'main_frame', 'csp_report']);
chrome.webRequest.onBeforeRequest.addListener((d) => {
  const fromVoice = d.initiator?.startsWith('https://voice.google.com') || voiceTabs.has(d.tabId);
  if (!fromVoice || SKIP_TYPES.has(d.type)) return;
  let key;
  try {
    const u = new URL(d.url);
    key = `${u.host}${u.pathname.replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id').replace(/\/\d+/g, '/:n')}`.slice(0, 120);
  } catch { return; }
  const via = d.initiator && !d.initiator.startsWith('https://voice.google.com') ? ` [via ${d.initiator.replace('https://', '')}]` : '';
  const kind = d.type === 'xmlhttprequest' ? '' : ` [${d.type}]`;
  const k = `${key}${d.tabId < 0 ? ' [worker]' : ''}${kind}${via}`;
  netBuf[k] = (netBuf[k] || 0) + 1;
  if (API_RE.test(key)) netBuf.__api = (netBuf.__api || 0) + 1;
  clearTimeout(netFlush);
  netFlush = setTimeout(flushNet, 3000);
}, { urls: ['https://*.google.com/*', 'https://*.googleapis.com/*'] });

async function flushNet() {
  const buf = netBuf; netBuf = {};
  const { net = {}, apiSinceLoad = 0 } = await get(['net', 'apiSinceLoad']);
  for (const [k, v] of Object.entries(buf)) if (k !== '__api') net[k] = (net[k] || 0) + v;
  const top = Object.fromEntries(Object.entries(net).sort((a, b) => b[1] - a[1]).slice(0, 40));
  await set({ net: top, apiSinceLoad: apiSinceLoad + (buf.__api || 0) });
}

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
      case 'reload-voice': {
        const tabs = await chrome.tabs.query({ url: 'https://voice.google.com/*' });
        for (const t of tabs) await chrome.tabs.reload(t.id);
        if (!tabs.length) await openVoice();
        break;
      }
      case 'idb-census': await set({ idb: msg.dbs }); break;
      case 'page-load':
        if (msg.fresh) await set({ needsVoiceReload: false, pageLoadAt: Date.now(), capturesSinceLoad: 0, apiSinceLoad: 0 });
        await refreshStatus();
        break;
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
  // diagnostics: which Voice endpoints the page uses (path only, no data)
  const u = String(url);
  const legacy = /voiceclient\//.test(u);
  const path = ((u.match(/voiceclient\/([a-z0-9/_]+)/i) || u.match(/\$rpc\/google\.voice\.([A-Za-z0-9_.]+\/[A-Za-z0-9_]+)/) || [])[1])
    || (/signaler/.test(u) ? 'push-channel' : 'other');
  health.endpoints = { ...(health.endpoints || {}), [path]: ((health.endpoints || {})[path] || 0) + 1 };
  // shape only (no content): helps map new Voice formats from the dashboard diagnostics
  if (!legacy) {
    health.shapes = { ...(health.shapes || {}), [path.slice(0, 80)]: { len: body.length, head: body.slice(0, 1).replace(/[^\[\{)\]]/, '?'), at: Date.now() } };
    const keys = Object.keys(health.shapes);
    if (keys.length > 30) delete health.shapes[keys[0]];
  }

  // Local sample ring (never uploaded): last 4 responses per endpoint so rare ones (call history) survive.
  if (st.debugRecord || path !== 'push-channel') {
    let samples = st.samples || [];
    const same = samples.filter((x) => x.path === path);
    if (same.length >= 4) samples = samples.filter((x) => x !== same[0]);
    samples = [...samples, { path, url, at: Date.now(), body: body.slice(0, 200000), reqBody }].slice(-MAX_SAMPLES);
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
  if (legacy || events.length || agentNumber) {
    const { capturesSinceLoad = 0 } = await get('capturesSinceLoad');
    await set({ capturesSinceLoad: capturesSinceLoad + 1 });
  }
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
  // audio (voicemail / call recording) is copied to the dashboard after the event itself is synced
  const withMedia = events.filter((e) => e.media_url && Date.parse(e.occurred_at) >= since);
  if (withMedia.length) {
    await serial(async () => {
      const { media = [], mediaDone = {} } = await get(['media', 'mediaDone']);
      for (const e of withMedia) if (!mediaDone[e.gv_id] && !media.some((x) => x.id === e.gv_id)) media.push({ id: e.gv_id, url: e.media_url, tries: 0 });
      await set({ media });
    });
  }
  if (added) await refreshStatus();
  // New calls/texts reach the dashboard within seconds (debounced; the 1-minute alarm is the fallback).
  if (queue.length >= 50) sync();
  else if (added) { clearTimeout(syncSoon); syncSoon = setTimeout(sync, 3000); }
}
let syncSoon = null;

// ---------- shared status: badge + summary for panel and widget ----------
async function refreshStatus() {
  const st = await get(['events', 'timezone', 'agentToken', 'lastHeartbeat', 'lastSyncError', 'queue', 'paused', 'lastSyncAt',
    'needsVoiceReload', 'pageLoadAt', 'capturesSinceLoad', 'apiSinceLoad', 'serverSummary', 'serverSummaryAt']);
  const tz = st.timezone || DEFAULT_TZ;
  const today = dayKey(Date.now(), tz);
  // Prefer the server's numbers (same as the dashboard); fall back to the local cache when offline.
  const fresh = st.serverSummary?.today && Date.now() - (st.serverSummaryAt || 0) < 15 * 60e3 && !(st.queue || []).length;
  const summary = fresh ? st.serverSummary.today : summarize(Object.values(st.events || {}), today, today, tz);

  let level = 'ok';
  let text = 'Tracking';
  if (!st.agentToken) { level = 'bad'; text = 'Not connected — paste your token in Settings'; }
  else if (st.paused) { level = 'paused'; text = 'Paused'; }
  else if (!st.lastHeartbeat || Date.now() - st.lastHeartbeat > TAB_STALE_MS) { level = 'warn'; text = 'Open Google Voice to track'; }
  else if (st.needsVoiceReload) { level = 'warn'; text = 'Reload Google Voice to finish the update'; }
  else if (st.pageLoadAt && !st.capturesSinceLoad && Date.now() - st.pageLoadAt > 90e3) {
    level = 'bad';
    text = st.apiSinceLoad > 0
      ? 'Voice is active but its data can\'t be read — diagnostics sent to your admin'
      : 'No Voice data detected — reload Google Voice';
  }
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

/** Health + diagnostics sent with every sync (no message content, only counts and endpoint paths). */
async function healthReport(health = {}) {
  await flushNet();
  const x = await get(['status', 'net', 'capturesSinceLoad', 'apiSinceLoad', 'pageLoadAt', 'needsVoiceReload', 'paused', 'pausedAt', 'idb', 'debugRecord', 'samples', 'media', 'mediaStats']);
  return {
    ...health, sendChecks: undefined,
    paused: !!x.paused, status: x.status?.text || null,
    extensionVersion: chrome.runtime.getManifest().version, parserVersion: PARSER_VERSION,
    pageLoadAt: x.pageLoadAt || null, capturesSinceLoad: x.capturesSinceLoad || 0, apiSinceLoad: x.apiSinceLoad || 0,
    needsVoiceReload: !!x.needsVoiceReload, net: x.net || {}, idb: x.idb || [],
    recording: !!x.debugRecord, samples: (x.samples || []).length,
    audio: { ...(x.mediaStats || { uploaded: 0, failed: 0 }), pending: (x.media || []).length },
  };
}

/**
 * Copy voicemail / call-recording audio into the dashboard's private storage. Google's media links only
 * work with the agent's own Google sign-in, so the extension downloads the file and uploads it.
 */
let uploading = false;
async function uploadMedia() {
  if (uploading) return;
  uploading = true;
  try {
    const { media = [], agentToken, paused } = await get(['media', 'agentToken', 'paused']);
    if (!agentToken || paused || !media.length) return;
    const done = {}; const failed = [];
    for (const m of media.slice(0, 5)) {
      try {
        const r = await fetch(m.url, { credentials: 'include', signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`download ${r.status}`);
        const blob = await r.blob();
        const type = /^audio\//.test(blob.type) ? blob.type : 'audio/mpeg';
        const u = await fetch(`${INGEST_URL}?media=${encodeURIComponent(m.id)}`, {
          method: 'POST', headers: { 'x-agent-token': agentToken, 'Content-Type': type }, body: blob, signal: AbortSignal.timeout(120000),
        });
        const out = await u.json().catch(() => ({}));
        if (!u.ok) throw new Error(out.error || `upload ${u.status}`);
        if (!out.attached && !out.skipped) throw new Error('event not synced yet');
        done[m.id] = Date.now();
      } catch (e) {
        if (m.tries < 6) failed.push({ ...m, tries: m.tries + 1, error: String(e.message || e).slice(0, 80) });
      }
    }
    const handled = new Set(media.slice(0, 5).map((m) => m.id));
    await serial(async () => {
      const cur = await get(['media', 'mediaDone', 'mediaStats']);
      const stats = cur.mediaStats || { uploaded: 0, failed: 0 };
      stats.uploaded += Object.keys(done).length;
      stats.failed += media.slice(0, 5).length - Object.keys(done).length;
      if (failed.length) stats.lastError = failed[failed.length - 1].error;
      const mediaDone = { ...(cur.mediaDone || {}), ...done };
      for (const [k, t] of Object.entries(mediaDone)) if (t < Date.now() - KEEP_DAYS * 864e5) delete mediaDone[k];
      await set({ media: [...(cur.media || []).filter((x) => !handled.has(x.id)), ...failed], mediaDone, mediaStats: stats });
    });
  } finally {
    uploading = false;
  }
}

let syncing = false;
async function sync() {
  if (syncing) return { ok: false, error: 'busy' };
  syncing = true;
  try {
    const st = await get(['agentToken', 'queue', 'agentNumber', 'heartbeatPending', 'health', 'backoffUntil', 'trackingStart']);
    if (!st.agentToken) return { ok: false, error: 'Not connected' };
    if (st.backoffUntil && Date.now() < st.backoffUntil) return { ok: false, error: 'Waiting to retry' };
    if (!(st.queue || []).length && !st.heartbeatPending) { uploadMedia(); return { ok: true, sent: 0 }; }

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
          heartbeat: { at: new Date().toISOString(), health: await healthReport(st.health) },
          events: batch,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) throw new Error('Token rejected — ask your manager for a new token');
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const out = await res.json();
      if (out.agent?.name) await set({ agentName: out.agent.name });
      if (out.summary) await set({ serverSummary: out.summary, serverSummaryAt: Date.now() });
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
    uploadMedia();
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
