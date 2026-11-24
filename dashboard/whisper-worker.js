// Web Worker: Whisper (Transformers.js) in the admin's browser — the fallback when the server (Groq) can't transcribe.
// In:  { id, model, clips: Float32Array[] (16 kHz mono, each ≤ 30 s of speech) }
// Out: { type: 'progress', id, … } | { type: 'done', id, texts: string[] } | { type: 'error', id, error }
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false; // models come from the Hugging Face hub (cached by the browser after the first use)

let asr = null;
let loaded = '';

async function load(model, id) {
  if (asr && loaded === model) return asr;
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'ready' || p.status === 'initiate') self.postMessage({ type: 'progress', id, status: p.status, file: p.file, progress: p.progress });
  };
  const gpu = 'gpu' in navigator && (await navigator.gpu.requestAdapter().catch(() => null));
  try {
    // large models: fp16 encoder + 4-bit decoder on WebGPU (best accuracy / speed); 8-bit on WebAssembly
    asr = await pipeline('automatic-speech-recognition', model, gpu
      ? { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, progress_callback }
      : { device: 'wasm', dtype: 'q8', progress_callback });
  } catch (e) {
    if (!gpu) throw e;
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  }
  loaded = model;
  return asr;
}

self.onmessage = async ({ data }) => {
  const { id, model, clips } = data;
  try {
    const run = await load(model, id);
    const english = /\.en$/.test(model);
    const texts = [];
    for (let i = 0; i < clips.length; i++) {
      // multilingual models: say it's English (much better than auto-detect on short phone clips)
      const out = await run(clips[i], english ? {} : { language: 'english', task: 'transcribe' });
      texts.push(String(out?.text || '').trim());
      self.postMessage({ type: 'progress', id, status: 'clip', progress: Math.round(((i + 1) / clips.length) * 100) });
    }
    self.postMessage({ type: 'done', id, texts });
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String(e?.message || e) });
  }
};
