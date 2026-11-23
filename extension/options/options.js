import { DEFAULT_TZ } from '../src/lib/metrics.js';

const $ = (id) => document.getElementById(id);
let editing = false;

function setMsg(text, cls = '') { $('msg').textContent = text; $('msg').className = `small ${cls}`; }

async function load() {
  const st = await chrome.storage.local.get(null);
  const connected = !!st.agentToken && !editing;
  $('connectedBox').hidden = !connected;
  $('connectForm').hidden = connected;
  $('connect').hidden = connected;
  $('change').hidden = !connected;
  $('disconnect').hidden = !st.agentToken;
  $('agentName').textContent = st.agentName || 'Your agent';
  $('agentMeta').textContent = [st.agentNumber && `Voice number ${st.agentNumber}`, st.lastSyncAt && `last sync ${new Date(st.lastSyncAt).toLocaleTimeString()}`, st.lastSyncError].filter(Boolean).join(' · ');

  $('showWidget').checked = st.showWidget !== false;
  $('debugRecord').checked = !!st.debugRecord;
  const tz = st.timezone || DEFAULT_TZ;
  const since = st.trackingStart ? new Date(st.trackingStart).toLocaleString('en-US', { timeZone: tz }) : '—';
  $('trackInfo').textContent = `Tracking from ${since} (install day onward) · business timezone ${tz}${st.paused ? ' · PAUSED' : ''}`;
  const h = st.health || {};
  const checks = h.sendChecks || [];
  $('health').textContent = [
    `Status: ${st.status?.text || '—'}`,
    `Responses captured: ${h.captures || 0}`,
    `Events parsed: ${h.parsed || 0}  (unclassified: ${h.unknown || 0})`,
    `Sent-text self-check: ${checks.filter((c) => c.matched).length}/${checks.length} matched`,
    `Waiting to sync: ${(st.queue || []).length}   Samples recorded: ${(st.samples || []).length}`,
  ].join('\n');
}

$('connect').addEventListener('click', async () => {
  const btn = $('connect');
  btn.disabled = true;
  setMsg('Checking token…');
  const r = await chrome.runtime.sendMessage({ type: 'connect', token: $('agentToken').value });
  btn.disabled = false;
  if (r?.ok) {
    editing = false;
    $('agentToken').value = '';
    setMsg(`✓ Connected${r.agentName ? ` as ${r.agentName}` : ''}. Keep a Google Voice tab open.`, 'ok');
  } else {
    setMsg(`✗ ${r?.error || 'Could not connect'}`, 'err');
  }
  load();
});
$('agentToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect').click(); });
$('change').addEventListener('click', () => { editing = true; setMsg(''); load(); $('agentToken').focus(); });
$('disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect this computer? Tracking stops syncing until a token is connected again.')) return;
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  editing = false;
  setMsg('Disconnected.');
  load();
});
$('showWidget').addEventListener('change', (e) => chrome.storage.local.set({ showWidget: e.target.checked }));
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
