// ISOLATED world bridge: page -> service worker, plus a heartbeat while Voice is open.
// Safe to inject more than once and survives extension reloads (old copies go quiet).
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (window.__cocoBridgeAlive?.()) return; // a live copy is already running
  window.__cocoBridgeAlive = alive;

  const send = (msg) => { if (alive()) chrome.runtime.sendMessage(msg).catch(() => {}); };

  const onMessage = (ev) => {
    if (!alive()) { window.removeEventListener('message', onMessage); return; }
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'coco-gv') return;
    send({ type: 'gv-capture', url: d.url, body: d.body, reqBody: d.reqBody });
  };
  window.addEventListener('message', onMessage);

  const beat = () => {
    if (!alive()) { clearInterval(timer); return; }
    send({ type: 'heartbeat', visible: !document.hidden });
  };
  const timer = setInterval(beat, 5 * 60 * 1000);
  // fresh = injected at document_start by a normal page load (interceptor is the current version)
  send({ type: 'page-load', fresh: document.readyState === 'loading' });

  // Diagnostics: which IndexedDB databases/stores Google Voice keeps (names + row counts only, no data).
  async function idbCensus() {
    try {
      const dbs = (await indexedDB.databases?.()) || [];
      const out = [];
      for (const { name } of dbs.slice(0, 15)) {
        if (!name) continue;
        const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onupgradeneeded = () => { r.transaction.abort(); res(null); }; });
        if (!db) continue;
        const stores = [];
        for (const s of [...db.objectStoreNames].slice(0, 30)) {
          const n = await new Promise((res) => { try { const q = db.transaction(s, 'readonly').objectStore(s).count(); q.onsuccess = () => res(q.result); q.onerror = () => res(-1); } catch { res(-1); } });
          stores.push(`${s}:${n}`);
        }
        db.close();
        out.push({ name: name.slice(0, 80), stores });
      }
      send({ type: 'idb-census', dbs: out });
    } catch { /* ignore */ }
  }
  setTimeout(idbCensus, 20000);
  beat();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
})();
