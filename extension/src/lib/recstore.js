// Durable queue for call recordings made by the extension (IndexedDB in the service worker).
// A recording survives a closed tab, offline time and browser restarts until the server accepts it.
const DB = 'coco-recordings';
const STORE = 'pending';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const putRecording = (rec) => tx('readwrite', (s) => s.put(rec));
export const deleteRecording = (id) => tx('readwrite', (s) => s.delete(id));
export const listRecordings = () => tx('readonly', (s) => s.getAll());
export const countRecordings = () => tx('readonly', (s) => s.count());

/** base64 -> Blob (content scripts send audio as base64: extension messages are JSON-only). */
export function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
