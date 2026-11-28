import { DEFAULT_TZ } from '../src/lib/metrics.js';
import { DASHBOARD_URL } from '../src/config.js';

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
  const mine = chrome.runtime.getManifest().version;
  const up = st.latestExtension;
  $('verLine').innerHTML = up?.updateAvailable && up.version !== mine
    ? `Version ${mine} · <b style="color:var(--yellow)">update available: v${up.version}</b> · <a href="${DASHBOARD_URL}/#/extension" target="_blank" rel="noopener">How to update</a>`
    : `Version ${mine}${up ? ' · up to date' : ''}`;
  $('autoOpenVoice').checked = !!st.autoOpenVoice;
  $('debugRecord').checked = !!st.debugRecord;
  const tz = st.timezone || DEFAULT_TZ;
  const since = st.trackingStart ? new Date(st.trackingStart).toLocaleString('en-US', { timeZone: tz }) : 'not started — connect your token';
  $('trackInfo').textContent = `Tracking from ${since} (no old history) · Pakistan time${st.paused ? ' · PAUSED' : ''}`;
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
$('autoOpenVoice').addEventListener('change', (e) => chrome.storage.local.set({ autoOpenVoice: e.target.checked }));
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
// ---------- Vici Dialer ----------
const VICI_DEFAULT = 'https://dm26.callengine.org/agc/vicidial.php';
const viciMsg = (t, cls = '') => { $('viciMsg').textContent = t; $('viciMsg').className = `small ${cls}`; };
async function loadVici() {
  const st = await chrome.storage.local.get(['viciUrl', 'viciStatus', 'viciTest']);
  if (document.activeElement !== $('viciUrl')) $('viciUrl').value = st.viciUrl || VICI_DEFAULT;
  if (!$('viciMsg').dataset.busy) viciMsg(st.viciStatus ? `Status: ${st.viciStatus.text}` : '');
  const t = st.viciTest;
  $('viciSteps').replaceChildren(...(t ? t.steps : []).map((x) => {
    const li = document.createElement('li');
    li.textContent = `${x.ok ? '✅' : x.warn ? '⚠️' : '❌'} ${x.label}${x.fix ? ` — ${x.fix}` : ''}`;
    return li;
  }));
}
$('viciSave').addEventListener('click', async () => {
  let u;
  try { u = new URL($('viciUrl').value.trim() || VICI_DEFAULT); } catch { return viciMsg('That is not a web address. Copy it from the Vici login page.', 'err'); }
  if (u.protocol !== 'https:') return viciMsg('The Vici address must start with https://', 'err');
  const origin = `https://${u.hostname}/*`;
  // Vici servers outside callengine.org need Chrome's permission once (asked here, on your click)
  if (!/(^|\.)callengine\.org$/i.test(u.hostname)) {
    const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!ok) return viciMsg('Chrome permission was not given — Coco cannot see that Vici screen.', 'err');
  }
  await chrome.storage.local.set({ viciUrl: u.href });
  await chrome.runtime.sendMessage({ type: 'vici-url-changed' });
  viciMsg(`✓ Saved. Open ${u.hostname} and log in, then click Test Vici.`, 'ok');
});
$('viciOpen').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-vici' }));
$('viciTest').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; $('viciMsg').dataset.busy = '1'; viciMsg('Testing…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'vici-test' });
    viciMsg(r?.ok ? '✓ Vici is connected — make a test call and it will appear on the dashboard (Vici Dialer).' : 'Fix the first ❌ below, then test again.', r?.ok ? 'ok' : 'err');
  } finally { b.disabled = false; delete $('viciMsg').dataset.busy; loadVici(); }
});

chrome.storage.onChanged.addListener(load);
chrome.storage.onChanged.addListener(loadVici);
load();
loadVici();

document.querySelectorAll('.cy').forEach((e) => { e.textContent = String(new Date().getFullYear()); });
