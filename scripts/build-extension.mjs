// Package the Chrome extension for agents and publish its version info on the dashboard.
//
//   node scripts/build-extension.mjs "What changed" "Another change"
//
// Writes (then deploy the dashboard):
//   dashboard/downloads/coco-voice-extension.zip            always the latest (stable link for Slack messages)
//   dashboard/downloads/coco-voice-extension-<ver>.zip      versioned copy (last 3 kept)
//   dashboard/extension.json                                version, date, size, sha256, release notes history
// The zip contains one folder "coco-voice-extension/" (tests excluded). Agents unzip it OVER their existing
// folder and click Reload, so Chrome keeps the same extension id and their token stays connected.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'dashboard', 'downloads');
const INFO = path.join(ROOT, 'dashboard', 'extension.json');
const NAME = 'coco-voice-extension';

const { version } = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const notes = process.argv.slice(2).filter(Boolean);
const prev = fs.existsSync(INFO) ? JSON.parse(fs.readFileSync(INFO, 'utf8')) : { history: [] };

// stage a clean copy (no tests, no dotfiles)
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-ext-'));
const dest = path.join(stage, NAME);
fs.cpSync(EXT, dest, { recursive: true, filter: (src) => !/[\\/](test|\.[^\\/]+)$/.test(src) });

fs.mkdirSync(OUT, { recursive: true });
const zipV = path.join(OUT, `${NAME}-${version}.zip`);
fs.rmSync(zipV, { force: true });
// Windows ships bsdtar (zip via -a); elsewhere use the zip CLI
if (process.platform === 'win32') execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zipV, '-C', stage, NAME]);
else execFileSync('zip', ['-qr', zipV, NAME], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
fs.copyFileSync(zipV, path.join(OUT, `${NAME}.zip`));

// keep only the 3 newest versioned zips
const versioned = fs.readdirSync(OUT).filter((f) => new RegExp(`^${NAME}-\\d+\\.\\d+\\.\\d+\\.zip$`).test(f))
  .sort((a, b) => cmp(b.match(/(\d+\.\d+\.\d+)/)[1], a.match(/(\d+\.\d+\.\d+)/)[1]));
for (const f of versioned.slice(3)) fs.rmSync(path.join(OUT, f));

const buf = fs.readFileSync(zipV);
const released = new Date().toISOString();
const entry = { version, released, notes: notes.length ? notes : (prev.history.find((h) => h.version === version)?.notes || []) };
const info = {
  version,
  released,
  download: `/downloads/${NAME}.zip`,
  versioned: `/downloads/${NAME}-${version}.zip`,
  size: buf.length,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  min_chrome: JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).minimum_chrome_version || null,
  history: [entry, ...prev.history.filter((h) => h.version !== version)].slice(0, 20),
};
fs.writeFileSync(INFO, `${JSON.stringify(info, null, 2)}\n`);
console.log(`built ${NAME} ${version}: ${(buf.length / 1024).toFixed(0)} KB, sha256 ${info.sha256.slice(0, 12)}…`);

function cmp(a, b) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
