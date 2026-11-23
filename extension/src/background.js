// Service worker: parse -> filter (install day onward) -> dedupe -> queue -> sync to Supabase.
import { parseResponse, parseSendRequest, PARSER_VERSION } from './parser/gv-protojson.js';
import { DEFAULT_TZ, startOfDay } from './lib/metrics.js';

const KEEP_DAYS = 35;          // local history for the popup
const BATCH = 100;
const MAX_SAMPLES = 25;        // Phase 0 sample recorder

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// All read-modify-write of events/queue goes through this chain (no lost updates).
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

// ---------- install: tracking starts at 00:00 of install day (business TZ) ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { trackingStart, timezone } = await get(['trackingStart', 'timezone']);
  if (reason === 'install' || !trackingStart) {
    await set({
      trackingStart: startOfDay(Date.now(), timezone || DEFAULT_TZ),
      installedAt: Date.now(),
      timezone: timezone || DEFAULT_TZ,
      events: {}, queue: [], health: { captures: 0, parsed: 0, unknown: 0, sendChecks: [] },
    });
  }
  chrome.alarms.create('sync', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 1 }));

// ---------- messages from content script / popup / options ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'gv-capture') await serial(() => onCapture(msg));
    else if (msg.type === 'heartbeat') await set({ lastHeartbeat: Date.now(), heartbeatPending: true });
    else if (msg.type === 'sync-now') return reply(await sync());
    else if (msg.type === 'reset-local') { await serial(() => set({ events: {}, queue: [] })); return reply({ ok: true }); }
    reply({ ok: true });
  })().catch((e) => reply({ ok: false, error: String(e) }));
  return true;
});

async function onCapture({ url, body, reqBody }) {
  const st = await get(['agentNumber', 'trackingStart', 'events', 'queue', 'health', 'debugRecord', 'samples']);
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

  for (const e of events) {
    const at = Date.parse(e.occurred_at);
    if (at < since) continue;                                // only from install day onward
    const sig = `${e.type}|${e.direction}|${e.call_outcome}|${e.duration_sec}|${(e.body || '').length}`;
    const prev = local[e.gv_id];
    if (prev && prev.sig === sig) continue;                  // already have this exact version
    local[e.gv_id] = {
      k: e.type, d: e.direction === 'outbound' ? 'out' : e.direction === 'inbound' ? 'in' : '?',
      c: e.contact_number, at, o: e.call_outcome, s: e.duration_sec, sig,
    };
    queue.push(e);
    health.parsed++;
    if (e.type === 'unknown') health.unknown++;
    for (const chk of health.sendChecks || []) {
      if (!chk.matched && e.type === 'text' && e.direction === 'outbound'
          && e.contact_number === chk.contact && Math.abs(at - chk.at) < 5 * 60e3) chk.matched = true;
    }
  }
  for (const [id, v] of Object.entries(local)) if (v.at < cutoff) delete local[id];

  await set({ events: local, queue, health });
  if (queue.length >= 50) sync();
}

// ---------- sync ----------
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') sync(); });

let syncing = false;
async function sync() {
  if (syncing) return { ok: false, error: 'busy' };
  syncing = true;
  try {
    const st = await get(['supabaseUrl', 'agentToken', 'queue', 'agentNumber', 'heartbeatPending', 'health', 'backoffUntil', 'trackingStart']);
    if (!st.supabaseUrl || !st.agentToken) return { ok: false, error: 'Not configured' };
    if (st.backoffUntil && Date.now() < st.backoffUntil) return { ok: false, error: 'backoff' };
    if (!(st.queue || []).length && !st.heartbeatPending) return { ok: true, sent: 0 };

    let sent = 0;
    let batch;
    do {
      batch = ((await get('queue')).queue || []).slice(0, BATCH);
      const res = await fetch(`${st.supabaseUrl.replace(/\/$/, '')}/functions/v1/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': st.agentToken },
        body: JSON.stringify({
          parser_version: PARSER_VERSION,
          agent_number: st.agentNumber || null,
          tracking_start: st.trackingStart ? new Date(st.trackingStart).toISOString() : null,
          heartbeat: { at: new Date().toISOString(), health: { ...st.health, sendChecks: undefined } },
          events: batch,
        }),
      });
      if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const out = await res.json();
      if (out.config) {
        const upd = { timezone: out.config.timezone };
        if (out.config.tracking_start) upd.trackingStart = Math.max(Date.parse(out.config.tracking_start), 0);
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
    return { ok: true, sent };
  } catch (e) {
    const { failures = 0 } = await get('failures');
    const wait = Math.min(30 * 60e3, 60e3 * 2 ** failures);
    await set({ lastSyncError: String(e.message || e), failures: failures + 1, backoffUntil: Date.now() + wait });
    return { ok: false, error: String(e.message || e) };
  } finally {
    syncing = false;
  }
}
