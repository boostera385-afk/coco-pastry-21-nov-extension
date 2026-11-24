// Browser fallback transcription (Whisper in a Web Worker). Used when the server (Groq) can't do a job.
// Robustness / accuracy:
// - best model the computer can run: Whisper large-v3-turbo on WebGPU, small.en on WebAssembly;
// - voice activity detection: only real speech is sent to Whisper (no invented words in silences), each
//   utterance keeps its true start time so Agent / Caller lines come out in the right order;
// - each speaker transcribed separately (per-speaker files, or the two channels of the stereo file);
// - shared clean-up + "who answered" detection (transcript-core.js, same rules as the server).
import { cleanSegments, mergeTurns, formatTurns, detectAnsweredBy } from './transcript-core.js';

export const MODELS = {
  auto: 'Best for this computer (automatic)',
  'onnx-community/whisper-large-v3-turbo': 'Most accurate — large-v3-turbo (~800 MB once, needs WebGPU)',
  'onnx-community/whisper-small.en': 'Balanced — small.en (~250 MB once)',
  'onnx-community/whisper-base.en': 'Fast — base.en (~80 MB once, least accurate)',
};
let gpuOk = null;
export async function bestModel(choice = 'auto') {
  if (choice && choice !== 'auto') return choice;
  if (gpuOk === null) gpuOk = !!('gpu' in navigator && (await navigator.gpu.requestAdapter().catch(() => null)));
  return gpuOk ? 'onnx-community/whisper-large-v3-turbo' : 'onnx-community/whisper-small.en';
}

let worker = null;
let seq = 0;
const waiting = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    if (data.type === 'progress') w.onProgress?.(data);
    else { waiting.delete(data.id); data.type === 'done' ? w.resolve(data.texts) : w.reject(new Error(data.error)); }
  };
  worker.onerror = (e) => { waiting.forEach((w) => w.reject(new Error(e.message || 'transcriber failed to start'))); waiting.clear(); worker = null; };
  return worker;
}

/** Decode any browser-playable audio to 16 kHz Float32 channels (Whisper's input format). */
export async function decode(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    if (buf.sampleRate === 16000) { out.push(new Float32Array(buf.getChannelData(c))); continue; }
    const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
    const mono = off.createBuffer(1, buf.length, buf.sampleRate);
    mono.copyToChannel(buf.getChannelData(c), 0);
    const src = off.createBufferSource(); src.buffer = mono; src.connect(off.destination); src.start();
    out.push((await off.startRendering()).getChannelData(0));
  }
  return out;
}

/**
 * Energy-based voice activity detection. Returns speech regions [{ start, end }] in seconds.
 * The threshold adapts to each recording's noise floor, so quiet phone lines and loud ones both work.
 */
export function speechRegions(x, rate = 16000) {
  const frame = Math.round(rate * 0.03);
  const n = Math.floor(x.length / frame);
  if (!n) return [];
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += x[j] * x[j];
    db[i] = 10 * Math.log10(s / frame + 1e-10);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)];
  const peak = sorted[Math.floor(n * 0.98)];
  if (peak < -55 || peak - floor < 8) return []; // silent channel
  const thr = Math.max(floor + 0.35 * (peak - floor), -50);
  const regions = [];
  let start = -1; let quiet = 0;
  for (let i = 0; i < n; i++) {
    if (db[i] > thr) { if (start < 0) start = i; quiet = 0; } else if (start >= 0 && ++quiet > 20) { regions.push([start, i - quiet]); start = -1; quiet = 0; } // 0.6 s pause ends an utterance
  }
  if (start >= 0) regions.push([start, n - 1]);
  const t = frame / rate;
  return regions
    .map(([a, b]) => ({ start: Math.max(0, a * t - 0.25), end: Math.min(x.length / rate, (b + 1) * t + 0.3) }))
    .filter((r) => r.end - r.start >= 0.35);
}

/** Cut regions into clips of at most 28 s (Whisper's window). */
function clipsOf(x, regions, rate = 16000) {
  const clips = []; const meta = [];
  for (const r of regions) {
    for (let s = r.start; s < r.end; s += 28) {
      const e = Math.min(r.end, s + 28);
      clips.push(x.slice(Math.floor(s * rate), Math.ceil(e * rate)));
      meta.push({ start: s, end: e });
    }
  }
  return { clips, meta };
}

async function runClips(clips, model, onProgress) {
  if (!clips.length) return [];
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress: (p) => onProgress?.(p.status === 'clip' ? `Transcribing… ${p.progress}%` : p.status === 'progress' ? `Loading speech model… ${Math.round(p.progress || 0)}%` : 'Starting…') });
    w.postMessage({ id, model, clips });
  });
}

async function fetchAudio(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed (${res.status})`);
  return res.arrayBuffer();
}

/**
 * Transcribe one job. sources: { agentUrl?, callerUrl?, mixUrl } (signed links), labelled when two speakers are known.
 * Returns { text, answeredBy, model }.
 */
export async function transcribeSources({ agentUrl, callerUrl, mixUrl, voicemail = false }, { model: choice = 'auto', onProgress } = {}) {
  const model = await bestModel(choice);
  onProgress?.('Downloading audio…');
  let speakers; // [{ label, samples }]
  if (agentUrl && callerUrl) {
    const [a, c] = await Promise.all([fetchAudio(agentUrl).then(decode), fetchAudio(callerUrl).then(decode)]);
    speakers = [{ label: 'Agent', x: a[0] }, { label: 'Caller', x: c[0] }];
  } else {
    const ch = await decode(await fetchAudio(mixUrl));
    speakers = ch.length === 2 ? [{ label: 'Agent', x: ch[0] }, { label: 'Caller', x: ch[1] }] : [{ label: '', x: ch[0] }];
  }
  const lists = [];
  for (const sp of speakers) {
    const { clips, meta } = clipsOf(sp.x, speechRegions(sp.x));
    const texts = await runClips(clips, model, onProgress);
    lists.push(cleanSegments(texts.map((text, i) => ({ ...meta[i], text }))));
  }
  const labelled = speakers.length === 2;
  const turns = mergeTurns(lists, speakers.map((s) => s.label));
  if (voicemail) return { text: turns.map((t) => t.text).join(' '), answeredBy: null, model };
  return { text: formatTurns(turns), answeredBy: detectAnsweredBy(turns, { labelled }), model };
}
