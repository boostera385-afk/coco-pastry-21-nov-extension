import { summarize, dayKey, addDays, DEFAULT_TZ } from '../src/lib/metrics.js';

const $ = (id) => document.getElementById(id);
let range = 'today';

const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

async function render() {
  const st = await chrome.storage.local.get(null);
  const tz = st.timezone || DEFAULT_TZ;
  const today = dayKey(Date.now(), tz);
  const from = range === 'today' ? today : addDays(today, range === '7d' ? -6 : -29);
  const r = summarize(Object.values(st.events || {}), from, today, tz);

  for (const k of ['outboundReaches', 'outboundCalls', 'outboundTexts', 'inboundCalls', 'inboundTexts']) $(k).textContent = r[k];
  $('connected').textContent = `${r.connectedCalls} connected`;
  $('missed').textContent = `${r.missedCalls} missed`;
  $('callsInTile').classList.toggle('r', r.missedCalls > 0);
  $('callsInTile').classList.toggle('g', !r.missedCalls);
  $('vm').textContent = `${r.voicemails} voicemails`;

  const configured = st.supabaseUrl && st.agentToken;
  const tabOpen = st.lastHeartbeat && Date.now() - st.lastHeartbeat < 11 * 60e3;
  const queue = (st.queue || []).length;
  let cls = 'ok';
  let text = 'Tracking & synced';
  if (!configured) { cls = 'bad'; text = 'Not set up — open Settings'; }
  else if (!tabOpen) { cls = 'warn'; text = 'Open voice.google.com to track'; }
  else if (st.lastSyncError) { cls = 'bad'; text = 'Sync error — will retry'; }
  else if (queue) { cls = 'warn'; text = `${queue} waiting to sync`; }
  $('dot').className = `dot ${cls}`;
  $('statusText').textContent = text;
  $('statusSub').textContent = `Last sync ${ago(st.lastSyncAt)}${st.lastSyncError ? ' · ' + st.lastSyncError : ''}`;
  $('since').textContent = st.trackingStart
    ? `Tracking since ${new Date(st.trackingStart).toLocaleDateString('en-US', { timeZone: tz })} · ${tz} time`
    : '';
  $('sync').disabled = !configured;
  $('openDash').disabled = !st.dashboardUrl;
}

$('range').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  range = b.dataset.r;
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  $('sync').textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'sync-now' });
  $('sync').textContent = 'Sync now';
  render();
});
$('openDash').addEventListener('click', async () => {
  const { dashboardUrl } = await chrome.storage.local.get('dashboardUrl');
  if (dashboardUrl) chrome.tabs.create({ url: dashboardUrl });
});
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
chrome.storage.onChanged.addListener(render);
render();
