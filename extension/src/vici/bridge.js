// ISOLATED world bridge on the Vici Dialer pages (all frames): page -> service worker, and recording gate -> recorder.
// Separate from the Google Voice bridge (content.js) so Vici never touches Google Voice status or data.
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (window.__cocoViciBridgeAlive?.()) return;
  window.__cocoViciBridgeAlive = alive;
  const send = (msg) => { if (alive()) chrome.runtime.sendMessage(msg).catch(() => {}); };
  const toPage = (msg) => window.postMessage({ source: 'coco-ext', ...msg }, window.location.origin);

  const b64 = async (blob) => {
    if (!(blob instanceof Blob)) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  const onMessage = async (ev) => {
    if (!alive()) { window.removeEventListener('message', onMessage); return; }
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (d?.source === 'coco-vici') {
      if (d.type === 'event') send({ type: 'vici-event', event: d.event });
      else if (d.type === 'call-state') send({ type: 'vici-call-state', on: !!d.on, uid: d.uid });
      else if (d.type === 'sample') send({ type: 'vici-sample', sample: d.sample });
      else if (d.type === 'diag') send({ type: 'vici-diag', diag: d.diag });
      return;
    }
    if (d?.source !== 'coco-rec') return;
    if (d.type === 'state') send({ type: 'rec-state', recording: !!d.recording });
    else if (d.type === 'diag') send({ type: 'vici-rec-diag', diag: d.diag });
    else if (d.type === 'recording' && d.blob instanceof Blob) {
      try {
        send({ type: 'rec-file', source: 'vici', tag: d.tag || null, id: d.id, startedAt: d.startedAt, durationSec: d.durationSec, mime: d.mime,
          b64: await b64(d.blob), agentB64: await b64(d.agent), callerB64: await b64(d.caller) });
      } catch { /* ignore */ }
    }
  };
  window.addEventListener('message', onMessage);

  // Recorder in this frame (the browser phone may live in an iframe): record only while a Vici call is live.
  toPage({ type: 'rec-gate', on: false });
  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'vici-rec-gate') toPage({ type: 'rec-gate', on: !!m.on, uid: m.uid || null }); });

  const pushRecConfig = async () => {
    if (!alive()) return;
    const st = await chrome.storage.local.get(['agentToken', 'paused', 'recordCalls']);
    toPage({ type: 'rec-config', enabled: !!st.agentToken && !st.paused && st.recordCalls !== false });
  };
  pushRecConfig();
  const recTimer = setInterval(() => { if (!alive()) clearInterval(recTimer); else pushRecConfig(); }, 60e3);
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.agentToken || c.paused || c.recordCalls)) pushRecConfig(); });

  if (window === window.top) {
    send({ type: 'vici-page' });
    const beat = setInterval(() => { if (!alive()) clearInterval(beat); else send({ type: 'vici-page' }); }, 5 * 60e3);
  }
})();
