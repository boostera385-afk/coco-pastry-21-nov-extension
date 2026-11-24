import { summarize, dayKey, addDays, DEFAULT_TZ } from '../src/lib/metrics.js';
import { DASHBOARD_URL } from '../src/config.js';

const $ = (id) => document.getElementById(id);
let range = 'today';
let paused = false;

const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const DOT = { ok: 'ok', warn: 'warn', bad: 'bad', paused: '' };

async function render() {
  const st = await chrome.storage.local.get(null);
  const tz = st.timezone || DEFAULT_TZ;
  const today = dayKey(Date.now(), tz);
  const from = range === 'today' ? today : addDays(today, range === '7d' ? -6 : -29);
  const key = range === 'today' ? 'today' : range;
  const serverFresh = st.serverSummary?.[key] && Date.now() - (st.serverSummaryAt || 0) < 15 * 60e3 && !(st.queue || []).length;
  const r = serverFresh ? st.serverSummary[key] : summarize(Object.values(st.events || {}), from, today, tz);

  for (const k of ['outboundTotal', 'outboundCalls', 'outboundTexts', 'inboundCalls', 'inboundTexts']) $(k).textContent = r[k];
  $('outSub').textContent = `every call and text · ${r.contactsReached} contact${r.contactsReached === 1 ? '' : 's'} · ${r.inboundTotal} inbound`;
  $('connected').textContent = `${r.connectedCalls} picked up · ${r.conversations ?? 0} conv.`;
  $('connected').title = 'Picked up = person, voicemail or bot answered (Voice cannot tell which). Conversation = call of 60 s or more.';
  $('missed').textContent = `${r.missedCalls} missed · ${r.voicemails} voicemail${r.voicemails === 1 ? '' : 's'}`;
  $('callsInTile').classList.toggle('r', r.missedCalls + r.voicemails > 0);
  $('callsInTile').classList.toggle('g', !(r.missedCalls + r.voicemails));
  $('vm').textContent = 'received';

  const level = st.status?.level || (st.agentToken ? 'warn' : 'bad');
  $('dot').className = `dot ${DOT[level] ?? ''}`;
  $('statusText').textContent = st.status?.text || 'Starting…';
  $('who').textContent = st.agentToken ? `Connected as ${st.agentName || 'agent'}${st.agentNumber ? ` · ${st.agentNumber}` : ''}` : '';
  const recOn = st.recState?.on === true && Date.now() - (st.recState.at || 0) < 4 * 3600e3;
  const recTxt = !st.agentToken ? '' : st.recordCalls === false ? ' · call recording off (admin)' : recOn ? ' · ● recording this call' : ' · calls are recorded';
  $('statusSub').textContent = st.agentToken ? `Last sync ${ago(st.lastSyncAt)}${st.lastSyncError ? ` · ${st.lastSyncError}` : ''} · numbers ${serverFresh ? 'from dashboard' : 'local (not yet synced)'}${recTxt}` : '';
  $('openVoiceBox').hidden = !st.agentToken || st.paused || !(st.status?.voiceOpen === false || /Open Google Voice/i.test(st.status?.text || ''));
  $('goVoice').classList.toggle('attn', st.status?.voiceOpen === false && !!st.agentToken && !st.paused);
  $('setup').hidden = !!st.agentToken;
  const up = st.latestExtension;
  const mine = chrome.runtime.getManifest().version;
  const showUp = !!up?.updateAvailable && up.version !== mine;
  $('updateBox').hidden = !showUp;
  if (showUp) {
    $('updateVer').textContent = `v${up.version} (you have v${mine})`;
    $('updateNotes').textContent = (up.notes || []).join(' · ');
  }
  $('reloadVoice').hidden = !/reload Google Voice/i.test(st.status?.text || '');

  paused = !!st.paused;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('pause').className = `btn ${paused ? 'go' : 'stop'}`;
  $('pause').disabled = !st.agentToken;
  $('sync').disabled = !st.agentToken;
}

$('range').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  range = b.dataset.r;
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('pause').addEventListener('click', async () => {
  if (!paused && !confirm('Pause tracking? Live capture stops until you resume, and your manager will see that tracking is paused. Activity from the pause can still be counted from Voice history after you resume.')) return;
  await chrome.runtime.sendMessage({ type: 'set-paused', paused: !paused });
});
$('close').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    if (chrome.sidePanel?.close) { await chrome.sidePanel.close({ windowId: win.id }); return; }
  } catch { /* fall back below */ }
  window.close();
});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  $('sync').textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'sync-now' });
  $('sync').textContent = 'Sync now';
  render();
});
$('openVoice').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-voice' }));
$('goVoice').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-voice' }));
$('updateHow').addEventListener('click', () => chrome.tabs.create({ url: `${DASHBOARD_URL}/#/extension` }));
$('setup').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('reloadVoice').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'reload-voice' }));
$('openDash').addEventListener('click', () => chrome.tabs.create({ url: DASHBOARD_URL }));
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
chrome.storage.onChanged.addListener(render);
render();

document.querySelectorAll('.cy').forEach((e) => { e.textContent = String(new Date().getFullYear()); });

// Unpacked extension updated on disk but Chrome still runs the old code (the panel already reads the new files):
// compare the manifest on disk with the running one and offer a one-click restart.
(async () => {
  try {
    const running = chrome.runtime.getManifest().version;
    const onDisk = (await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json()).version;
    if (onDisk && onDisk !== running) {
      $('finishVer').textContent = `v${running} → v${onDisk}`;
      $('finishBox').hidden = false;
      $('finishUpdate').addEventListener('click', async () => {
        $('finishUpdate').disabled = true;
        $('finishUpdate').textContent = 'Restarting…';
        // after the restart the new version re-injects into open Voice tabs and asks for a Voice reload if needed
        chrome.runtime.reload();
      });
    }
  } catch { /* ignore */ }
})();
