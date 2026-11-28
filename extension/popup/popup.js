import { summarize, dayKey, addDays, DEFAULT_TZ } from '../src/lib/metrics.js';
import { DASHBOARD_URL } from '../src/config.js';
import { updateNow, canSelfUpdate } from '../src/lib/selfupdate.js';

const $ = (id) => document.getElementById(id);
let range = 'today';
let paused = false;

const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const DOT = { ok: 'ok', warn: 'warn', bad: 'bad', paused: '' };

const VICI_FIX = {
  closed: ['Open Vici', 'open-vici', 'Open your Vici agent screen in this browser and log in (user + phone).'],
  starting: ['Test Vici', 'vici-test', 'Coco is connecting to the open Vici screen. If this stays, click Test Vici.'],
  login: ['Go to Vici', 'open-vici', 'Log in on the Vici screen with your Vici user and phone login.'],
  ready: [null, null, 'Calls on the Vici screen are counted and recorded automatically.'],
  oncall: [null, null, 'This call is being tracked.'],
};
function renderVici(st) {
  const box = $('viciBox');
  box.hidden = !st.agentToken;
  if (box.hidden) return;
  const v = st.viciStatus || { state: 'closed', level: 'warn', text: 'Vici screen is not open' };
  $('viciDot').className = `dot ${DOT[v.level] ?? ''}`;
  $('viciState').textContent = v.text;
  const [label, action, help] = VICI_FIX[v.state] || VICI_FIX.closed;
  const need = !v.phone && (v.needPhone || []).length ? v.needPhone : [];
  const phone = need.length
    ? ` Calls are NOT recorded yet: your browser phone loads from ${need.map((x) => x.replace('https://', '').replace('/*', '')).join(', ')}. Click "Allow recording the phone" once.`
    : (v.state === 'ready' || v.state === 'oncall') && !v.phone ? ' Browser phone not seen yet — click Test Vici.' : '';
  $('viciHelp').textContent = help + phone;
  $('viciPhone').hidden = !need.length;
  $('viciPhone').dataset.hosts = JSON.stringify(need);
  $('viciFix').hidden = !label || label === 'Test Vici';
  if (label) { $('viciFix').textContent = label; $('viciFix').dataset.action = action; }
  const vs = st.viciSummary;
  $('viciCalls').textContent = vs?.calls ?? 0;
  const talk = Math.round((vs?.talkSec || 0) / 60);
  $('viciSub').textContent = `${vs?.connected ?? 0} connected · ${vs?.conversations ?? 0} conversations · ${talk} min talk`
    + `${v.user ? ` · user ${v.user}` : ''}${(st.viciQueue || []).length ? ` · ${st.viciQueue.length} waiting` : ''}${v.syncError ? ` · ${v.syncError}` : ''}`;
  const t = st.viciTest;
  const list = $('viciTestList');
  list.hidden = !t || Date.now() - t.at > 30 * 60e3;
  if (!list.hidden) {
    list.replaceChildren(...t.steps.map((x) => {
      const li = document.createElement('li');
      const ico = document.createElement('span'); ico.textContent = x.ok ? '✅' : x.warn ? '⚠️' : '❌';
      const txt = document.createElement('span'); txt.textContent = x.label;
      li.append(ico, txt);
      if (x.fix) { const f = document.createElement('span'); f.className = 'fix'; f.textContent = x.fix; li.append(f); }
      return li;
    }));
  }
}

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
  $('openVoiceBox').hidden = !st.agentToken || st.paused || !!st.status?.viciOpen || !(st.status?.voiceOpen === false || /Open Google Voice/i.test(st.status?.text || ''));
  $('goVoice').classList.toggle('attn', st.status?.voiceOpen === false && !!st.agentToken && !st.paused);
  $('setup').hidden = !!st.agentToken;
  // Vici Dialer: own card, own numbers (never added to the Google Voice tiles above)
  renderVici(st);
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
$('viciFix').addEventListener('click', (e) => chrome.runtime.sendMessage({ type: e.currentTarget.dataset.action || 'open-vici' }));
$('viciPhone').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  const hosts = JSON.parse(b.dataset.hosts || '[]');
  if (!hosts.length) return;
  // must run here (a click in the panel): Chrome asks the agent to allow Coco on the phone's address
  const ok = await chrome.permissions.request({ origins: hosts }).catch(() => false);
  if (!ok) { $('viciHelp').textContent = 'Not allowed — calls stay unrecorded. Click "Allow recording the phone" again and choose Allow.'; return; }
  const { viciPhoneHosts = [] } = await chrome.storage.local.get('viciPhoneHosts');
  await chrome.storage.local.set({ viciPhoneHosts: [...new Set([...viciPhoneHosts, ...hosts])] });
  await chrome.runtime.sendMessage({ type: 'vici-url-changed' });
  b.hidden = true;
  $('viciHelp').textContent = 'Allowed. Between calls, log out of Vici and log in again once — then click Test Vici: "Browser phone detected" should be ✅.';
});
$('viciTest').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Testing…';
  try { await chrome.runtime.sendMessage({ type: 'vici-test' }); } finally { b.disabled = false; b.textContent = 'Test Vici'; }
});
$('goVoice').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-voice' }));
$('updateHow').addEventListener('click', () => chrome.tabs.create({ url: `${DASHBOARD_URL}/#/extension` }));
// One click: download the new version into Coco's own folder and restart (first time: pick the folder once)
$('updateNow').hidden = !canSelfUpdate();
$('updateNow').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const say = (t) => { $('updateMsg').textContent = t; };
  try {
    const v = await updateNow(say);
    say(`Updated to v${v} — restarting…`);
  } catch (err) {
    btn.disabled = false;
    say(err?.name === 'AbortError' ? 'Cancelled — click Update now again when ready.' : `Couldn't update: ${err.message || err}. Use Manual steps instead.`);
  }
});
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
