// ISOLATED world bridge: page -> service worker. Also sends a heartbeat while Voice is open.
window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  const d = ev.data;
  if (!d || d.source !== 'coco-gv') return;
  chrome.runtime.sendMessage({ type: 'gv-capture', url: d.url, body: d.body, reqBody: d.reqBody }).catch(() => {});
});

const beat = () => chrome.runtime.sendMessage({ type: 'heartbeat', visible: !document.hidden }).catch(() => {});
beat();
setInterval(beat, 5 * 60 * 1000);
