// ISOLATED world on the Coco dashboard: lets the dashboard ask THIS browser's extension to dial a number on the
// Vici agent screen (click-to-dial). The dashboard never gets a Vici password or talks to the Vici server itself.
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (window.__cocoDashLinkAlive?.()) return;
  window.__cocoDashLinkAlive = alive;
  const reply = (msg) => window.postMessage({ source: 'coco-ext-dash', ...msg }, window.location.origin);

  const hello = async () => {
    if (!alive()) return;
    const st = await chrome.storage.local.get(['agentToken', 'paused', 'status']);
    reply({ type: 'hello', version: chrome.runtime.getManifest().version, connected: !!st.agentToken, paused: !!st.paused, viciOpen: !!st.status?.viciOpen });
  };

  window.addEventListener('message', async (ev) => {
    if (!alive() || ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (d?.source !== 'coco-dash') return;
    if (d.type === 'ping') hello();
    else if (d.type === 'dial') {
      const r = await chrome.runtime.sendMessage({ type: 'vici-dial', phone: String(d.phone || '').slice(0, 30) })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      reply({ type: 'dial-result', reqId: d.reqId, ...(r || { ok: false, error: 'No answer from the extension' }) });
    }
  });
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.status || c.agentToken || c.paused)) hello(); });
  hello();
})();
