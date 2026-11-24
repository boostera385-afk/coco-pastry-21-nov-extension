// One-click update check against the LIVE dashboard: loads a copy of the extension pretending to be one version
// older, points the updater at a stand-in folder (the browser's private file system — the real folder picker can't
// be clicked by a script), runs "Update now" and verifies every file of the published zip was written, manifest last.
// Usage: node tests/e2e/selfupdate.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }
const findChromium = () => {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('No Playwright Chromium found');
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-selfupd-'));
const ext = path.join(tmp, 'ext'); const userDir = path.join(tmp, 'profile');
fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const live = await (await fetch('https://coco-voice-dashboard.vercel.app/extension.json', { cache: 'no-store' })).json();
const [a, b, c] = live.version.split('.').map(Number);
man.version = c > 0 ? `${a}.${b}.${c - 1}` : `${a}.${b - 1}.9`; // one version older than the published one
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(man, null, 2));

let chrome; let ok = false;
try {
  chrome = spawn(findChromium(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000);
  const cdp = await CDP.connect(PORT);
  const sw = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 20000);
  const extId = sw.url.split('/')[2];
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  const s = await cdp.attach(targetId);
  await waitFor(() => cdp.eval(s, "location.protocol === 'chrome-extension:' && document.readyState === 'complete' && !!navigator.storage"), 15000);
  const out = await cdp.eval(s, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('coco-ext', { create: true });
    const w = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await w.write(JSON.stringify(chrome.runtime.getManifest())); await w.close();
    await new Promise((res, rej) => { const r = indexedDB.open('coco-update', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(dir, 'folder'); tx.oncomplete = res; tx.onerror = rej; }; });
    const { updateNow } = await import('/src/lib/selfupdate.js');
    const steps = [];
    const v = await updateNow((t) => steps.push(t));
    const read = async (p) => { let d = dir; const parts = p.split('/'); for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x); return (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); };
    return { v, steps, manifest: JSON.parse(await read('manifest.json')).version, recorder: (await read('src/recorder.js')).length, panel: (await read('popup/popup.js')).includes('updateNow') };
  })()`).catch((e) => ({ error: String(e) }));
  console.log(`running v${man.version} → published v${live.version}`);
  if (out.error) console.log(`FAIL  ${out.error}`);
  else {
    ok = out.v === live.version && out.manifest === live.version && out.recorder > 1000 && out.panel;
    console.log(`${ok ? 'PASS' : 'FAIL'}  one click wrote v${out.manifest} into the folder (recorder ${out.recorder} bytes, new side panel ${out.panel})`);
    console.log(`      steps: ${out.steps.join(' → ')}`);
  }
  cdp.close();
} catch (e) { console.log('FAIL ', e.message); } finally {
  try { chrome?.kill(); } catch { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(ok ? 0 : 1);
