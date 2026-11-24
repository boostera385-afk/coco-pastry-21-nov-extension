// Web Worker: speech-to-text with Whisper (Transformers.js), entirely in the admin's browser.
// Audio never leaves the computer; only the model files are downloaded once (then cached by the browser).
// In:  { id, model, channels: Float32Array[] (16 kHz mono each) }
// Out: { type: 'progress', id, status, progress } | { type: 'done', id, results: [{ text, chunks }] } | { type: 'error', id, error }
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false; // models come from the Hugging Face hub (cached in the browser after the first use)

let asr = null;
let loaded = '';

async function load(model, id) {
  if (asr && loaded === model) return asr;
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'ready' || p.status === 'initiate') {
      self.postMessage({ type: 'progress', id, status: p.status, file: p.file, progress: p.progress });
    }
  };
  // WebGPU is much faster when the browser supports it; fall back to WebAssembly otherwise.
  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator && (await navigator.gpu.requestAdapter().catch(() => null));
  try {
    asr = await pipeline('automatic-speech-recognition', model, gpu
      ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
      : { device: 'wasm', dtype: 'q8', progress_callback });
  } catch (e) {
    if (!gpu) throw e;
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  }
  loaded = model;
  return asr;
}

self.onmessage = async ({ data }) => {
  const { id, model, channels } = data;
  try {
    const run = await load(model, id);
    const results = [];
    for (const audio of channels) {
      if (!audio) { results.push(null); continue; }
      // long calls: 30 s windows with overlap; timestamps let the page interleave agent and caller lines
      const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
      results.push({ text: out.text || '', chunks: out.chunks || [] });
    }
    self.postMessage({ type: 'done', id, results });
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String(e?.message || e) });
  }
};
