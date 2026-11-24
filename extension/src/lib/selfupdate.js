// One-click update for the unpacked extension (side panel / settings page only: needs a user click).
// Chrome can't auto-update a "Load unpacked" extension, so Coco updates its own folder:
//   1. first time only: the agent picks the Coco extension folder (Chrome remembers it);
//   2. download the zip published on the dashboard, check its SHA-256 against extension.json;
//   3. unpack, write every file (manifest.json last), restart the extension.
// The folder is checked before anything is written (must contain Coco's manifest with the running version).
import { DASHBOARD_URL } from '../config.js';
import { unzip } from './unzip.js';

const DB = 'coco-update';
const idb = (mode, fn) => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const tx = r.result.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { resolve(req?.result); r.result.close(); };
    tx.onerror = () => { reject(tx.error); r.result.close(); };
  };
});
const saveFolder = (h) => idb('readwrite', (s) => s.put(h, 'folder'));
const loadFolder = () => idb('readonly', (s) => s.get('folder')).catch(() => null);

export const canSelfUpdate = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function readManifest(dir) {
  try { return JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text()); } catch { return null; }
}

/** Is this the folder Chrome loaded Coco from? (Coco's manifest + same version as the one running) */
async function isOurFolder(dir) {
  const m = await readManifest(dir);
  const me = chrome.runtime.getManifest();
  const v = (x) => String(x || '0').split('.').map(Number);
  const [a, b] = [v(m?.version), v(me.version)];
  const notOlder = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : (a[2] || 0) >= (b[2] || 0);
  return !!m && m.name === me.name && notOlder; // same folder; may already hold newer files (update half-done)
}

async function folderWithPermission(onStatus) {
  let dir = await loadFolder();
  if (dir) {
    let perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted' && await isOurFolder(dir)) return dir;
  }
  onStatus?.('Pick the Coco extension folder (the one you loaded in chrome://extensions) — only needed once.');
  dir = await window.showDirectoryPicker({ id: 'coco-extension', mode: 'readwrite' });
  if (!await isOurFolder(dir)) {
    throw new Error(`That isn't the Coco extension folder. Pick the folder that contains Coco's manifest.json (version ${chrome.runtime.getManifest().version}).`);
  }
  await saveFolder(dir);
  return dir;
}

const sha256 = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function writeFile(root, path, data) {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((x) => x === '..' || x === '.')) throw new Error(`unsafe path in update: ${path}`);
  let dir = root;
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
  const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

/** Run the whole update from a click handler. onStatus(text) for progress. Resolves just before the restart. */
export async function updateNow(onStatus) {
  onStatus?.('Checking the latest version…');
  const info = await (await fetch(`${DASHBOARD_URL}/extension.json`, { cache: 'no-store' })).json();
  if (!/^\d+\.\d+\.\d+$/.test(info.version || '')) throw new Error('No update information found');
  const dir = await folderWithPermission(onStatus);
  onStatus?.(`Downloading v${info.version}…`);
  const res = await fetch(`${DASHBOARD_URL}${info.versioned || info.download}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  if (info.sha256 && (await sha256(buf)) !== info.sha256) throw new Error('Download check failed (file changed in transit) — nothing was changed');
  onStatus?.('Unpacking…');
  const files = (await unzip(buf)).map((f) => ({ ...f, name: f.name.replace(/^[^/]+\//, '') })); // drop the zip's top folder
  const manifest = files.find((f) => f.name === 'manifest.json');
  if (!manifest) throw new Error('Update has no manifest.json — nothing was changed');
  const next = JSON.parse(new TextDecoder().decode(manifest.data));
  if (next.name !== chrome.runtime.getManifest().name) throw new Error('Update is not Coco — nothing was changed');
  onStatus?.(`Installing v${next.version}…`);
  for (const f of files) if (f.name !== 'manifest.json') await writeFile(dir, f.name, f.data);
  await writeFile(dir, 'manifest.json', manifest.data); // last: Chrome only sees the new version once every file is in place
  onStatus?.('Restarting Coco…');
  await chrome.storage.local.set({ selfUpdatedAt: Date.now(), selfUpdatedTo: next.version });
  setTimeout(() => chrome.runtime.reload(), 300);
  return next.version;
}
