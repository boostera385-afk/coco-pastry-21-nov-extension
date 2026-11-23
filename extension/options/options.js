import { DEFAULT_TZ } from '../src/lib/metrics.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['supabaseUrl', 'agentToken', 'dashboardUrl'];

async function load() {
  const st = await chrome.storage.local.get(null);
  FIELDS.forEach((f) => { if (document.activeElement !== $(f)) $(f).value = st[f] || ''; });
  $('debugRecord').checked = !!st.debugRecord;
  const tz = st.timezone || DEFAULT_TZ;
  const since = st.trackingStart ? new Date(st.trackingStart).toLocaleString('en-US', { timeZone: tz }) : '—';
  $('trackInfo').textContent = `Tracking from ${since} (install day onward) · business timezone ${tz} · Voice number ${st.agentNumber || 'not detected yet'}`;
  const h = st.health || {};
  const checks = h.sendChecks || [];
  $('health').textContent = [
    `Responses captured: ${h.captures || 0}`,
    `Events parsed: ${h.parsed || 0}  (unclassified: ${h.unknown || 0})`,
    `Sent-text self-check: ${checks.filter((c) => c.matched).length}/${checks.length} matched`,
    `Queue: ${(st.queue || []).length}   Samples recorded: ${(st.samples || []).length}`,
  ].join('\n');
}

$('save').addEventListener('click', async () => {
  const vals = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  if (vals.supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(vals.supabaseUrl)) {
    $('msg').textContent = 'URL must look like https://xxxx.supabase.co';
    return;
  }
  await chrome.storage.local.set({ ...vals, backoffUntil: 0, failures: 0, heartbeatPending: true });
  $('msg').textContent = 'Testing…';
  const r = await chrome.runtime.sendMessage({ type: 'sync-now' });
  $('msg').textContent = r?.ok ? '✓ Connected' : `✗ ${r?.error || 'failed'}`;
  load();
});
$('debugRecord').addEventListener('change', (e) => chrome.storage.local.set({ debugRecord: e.target.checked }));
$('clear').addEventListener('click', async () => { await chrome.storage.local.set({ samples: [] }); load(); });
$('download').addEventListener('click', async () => {
  const { samples = [] } = await chrome.storage.local.get('samples');
  // keep 13-digit ms timestamps, mask everything that looks like a phone number
  const redact = (s) => (s || '').replace(/\+?\d{10,14}/g, (m) => (/^\d{13}$/.test(m) ? m : `+1XXXXXXX${m.slice(-2)}`));
  const out = samples.map((s) => ({ ...s, body: redact(s.body), reqBody: redact(s.reqBody) }));
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: 'gv-samples.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
chrome.storage.onChanged.addListener(load);
load();
