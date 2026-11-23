// Renders brand/*.svg to PNG icons with headless Chrome (no npm dependencies).
// Usage: node brand/render-icons.mjs ["C:/Program Files/Google/Chrome/Application/chrome.exe"]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-icons-'));

const jobs = [
  // extension (Chrome uses 16 in the toolbar, 32 on hi-dpi, 48 on the extensions page, 128 in the store/install dialog)
  ['icon-small.svg', 16, 'extension/icons/icon-16.png'],
  ['icon-small.svg', 32, 'extension/icons/icon-32.png'],
  ['icon.svg', 48, 'extension/icons/icon-48.png'],
  ['icon.svg', 128, 'extension/icons/icon-128.png'],
  // dashboard
  ['icon-small.svg', 32, 'dashboard/icons/favicon-32.png'],
  ['icon-maskable.svg', 180, 'dashboard/icons/apple-touch-icon.png'],
  ['icon.svg', 192, 'dashboard/icons/icon-192.png'],
  ['icon.svg', 512, 'dashboard/icons/icon-512.png'],
  ['icon-maskable.svg', 512, 'dashboard/icons/maskable-512.png'],
];

for (const [src, size, out] of jobs) {
  const svgUrl = pathToFileURL(path.join(root, 'brand', src)).href;
  const html = path.join(tmp, `r-${size}-${src}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head>`
    + `<body><img src="${svgUrl}" width="${size}" height="${size}"></body></html>`);
  const dest = path.join(root, out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${size},${size}`,
    `--screenshot=${dest}`, pathToFileURL(html).href,
  ], { stdio: 'ignore' });
  console.log(`${out}  ${fs.statSync(dest).size} bytes`);
}
fs.copyFileSync(path.join(root, 'brand/icon-small.svg'), path.join(root, 'dashboard/icons/favicon.svg'));
fs.copyFileSync(path.join(root, 'brand/icon.svg'), path.join(root, 'dashboard/icons/logo.svg'));
console.log('dashboard/icons/favicon.svg + logo.svg copied');
fs.rmSync(tmp, { recursive: true, force: true });
