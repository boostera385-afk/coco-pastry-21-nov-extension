// Transcription on the admin's computer (Whisper in a Web Worker). Free and private: audio is decoded and
// transcribed locally; only the finished text is saved to the database.
// Coco's own call recordings are dual-channel (agent LEFT, caller RIGHT) → each side is transcribed
// separately and merged by time into "Agent: … / Caller: …" lines. Mono audio (Google voicemails) → plain text.

export const MODELS = {
  'onnx-community/whisper-base.en': 'Fast (English, ~80 MB download once)',
  'onnx-community/whisper-small.en': 'Accurate (English, ~250 MB download once, slower)',
  'onnx-community/whisper-base': 'Fast, any language (~80 MB)',
};
export const DEFAULT_MODEL = 'onnx-community/whisper-base.en';

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
    else { waiting.delete(data.id); data.type === 'done' ? w.resolve(data.results) : w.reject(new Error(data.error)); }
  };
  worker.onerror = (e) => { waiting.forEach((w) => w.reject(new Error(e.message || 'transcriber failed to start'))); waiting.clear(); worker = null; };
  return worker;
}

/** Decode any browser-playable audio to 16 kHz Float32 channels (Whisper's input format). */
async function decode(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  // decodeAudioData keeps the source rate in some browsers: resample to 16 kHz, per channel
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    if (buf.sampleRate === 16000) { out.push(buf.getChannelData(c)); continue; }
    const len = Math.ceil(buf.duration * 16000);
    const off = new OfflineAudioContext(1, len, 16000);
    const src = off.createBufferSource();
    const mono = off.createBuffer(1, buf.length, buf.sampleRate);
    mono.copyToChannel(buf.getChannelData(c), 0);
    src.buffer = mono; src.connect(off.destination); src.start();
    out.push((await off.startRendering()).getChannelData(0));
  }
  return { channels: out, duration: buf.duration };
}

const rms = (a) => { let s = 0; const step = Math.max(1, Math.floor(a.length / 200000)); let k = 0; for (let i = 0; i < a.length; i += step) { s += a[i] * a[i]; k++; } return Math.sqrt(s / Math.max(1, k)); };
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Merge per-speaker timestamped chunks into readable dialogue. */
export function mergeDialogue(results, labels) {
  const lines = [];
  results.forEach((r, i) => (r?.chunks || []).forEach((c) => {
    const text = String(c.text || '').trim();
    if (text && !/^\[?(blank_audio|music|silence)\]?$/i.test(text)) lines.push({ at: c.timestamp?.[0] ?? 0, who: labels[i], text });
  }));
  lines.sort((a, b) => a.at - b.at);
  const merged = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && last.who === l.who) last.text += ` ${l.text}`; else merged.push({ ...l });
  }
  return merged.map((l) => `[${clock(l.at)}] ${l.who}: ${l.text}`).join('\n');
}

/**
 * Transcribe one audio URL. onProgress({ stage, pct, text }) for the UI.
 * Returns the transcript text ('' when nothing was said).
 */
export async function transcribeUrl(url, { model = DEFAULT_MODEL, onProgress } = {}) {
  onProgress?.({ stage: 'download', text: 'Downloading audio…' });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed (${res.status})`);
  onProgress?.({ stage: 'decode', text: 'Decoding audio…' });
  const { channels } = await decode(await res.arrayBuffer());
  const stereo = channels.length === 2;
  // skip a silent side (e.g. muted mic) so Whisper doesn't invent words
  const input = channels.map((c) => (rms(c) > 0.002 ? c : null));
  if (!input.some(Boolean)) return '';
  const id = ++seq;
  const w = getWorker();
  const results = await new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress: (p) => onProgress?.({ stage: 'model', pct: p.progress, text: p.status === 'progress' ? `Loading speech model… ${Math.round(p.progress || 0)}%` : 'Transcribing…' }) });
    onProgress?.({ stage: 'model', text: 'Transcribing… (the first run downloads the speech model)' });
    w.postMessage({ id, model, channels: input.map((c) => (c ? new Float32Array(c) : null)) }); // copies: AudioBuffer memory can't be transferred
  });
  if (!stereo) return (results[0]?.text || '').trim();
  return mergeDialogue(results, ['Agent', 'Caller']);
}
