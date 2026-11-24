// POST /functions/v1/transcribe   { max?: number }
// Automatic transcription with Groq (Whisper large-v3-turbo). Called by /ingest right after a recording or
// voicemail arrives (service key), or by an admin from the dashboard ("Run now").
// Coco's own recordings come with one mono file per speaker -> each side is transcribed separately and merged
// into "Agent: … / Caller: …". Without a GROQ_API_KEY secret, jobs are handed to the dashboard's browser Whisper.
// Deploy: supabase functions deploy transcribe   ·   Secret: supabase secrets set GROQ_API_KEY=gsk_...
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cleanSegments, mergeTurns, formatTurns, detectAnsweredBy } from '../_shared/transcript-core.js';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const MODEL = Deno.env.get('GROQ_STT_MODEL') ?? 'whisper-large-v3-turbo';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Seg = { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number };
class RateLimited extends Error {}

async function groq(path: string, language: string, prompt: string): Promise<Seg[]> {
  const { data: blob, error } = await db.storage.from('recordings').download(path);
  if (error || !blob) throw new Error(`audio download: ${error?.message ?? 'missing'}`);
  if (blob.size < 200) return [];
  const form = new FormData();
  form.append('file', new File([blob], path.split('/').pop() || 'audio.webm', { type: blob.type || 'audio/webm' }));
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(0, 600));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form, signal: AbortSignal.timeout(120000),
    });
    if (r.status === 429) throw new RateLimited('Groq rate limit — will retry shortly');
    if (r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Groq ${r.status}: ${out?.error?.message ?? 'error'}`);
    return (out.segments ?? []) as Seg[];
  }
  throw new Error('Groq unavailable');
}

async function setStatus(patch: Record<string, unknown>) {
  const { data } = await db.from('app_settings').select('transcribe_status').eq('id', 1).maybeSingle();
  await db.from('app_settings').update({ transcribe_status: { ...(data?.transcribe_status ?? {}), ...patch, at: new Date().toISOString() } }).eq('id', 1);
}

async function isAllowed(req: Request) {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return false;
  if (jwt === SERVICE_KEY) return true;
  // the platform gateway already verified the JWT signature (verify_jwt on): trust its role claim
  try {
    const claims = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.role === 'service_role') return true;
  } catch { /* not a JWT */ }
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: p } = await db.from('profiles').select('role').eq('user_id', data.user.id).maybeSingle();
  return p?.role === 'admin';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await isAllowed(req))) return json({ error: 'not allowed' }, 401);
  const body = await req.json().catch(() => ({}));
  const max = Math.max(1, Math.min(10, Number(body.max) || 3));

  await db.rpc('enqueue_transcriptions');
  const { data: jobs, error } = await db.rpc('claim_transcriptions', { p_mode: 'server', p_limit: max });
  if (error) return json({ error: error.message }, 500);
  if (!jobs?.length) return json({ ok: true, done: 0 });

  if (!GROQ_KEY) {
    for (const j of jobs) await db.rpc('fail_transcription', { p_job: j.job_id, p_error: 'No GROQ_API_KEY on the server: transcribed by the dashboard instead', p_no_provider: true });
    await setStatus({ provider: 'browser', note: 'GROQ_API_KEY not set' });
    return json({ ok: true, done: 0, handed_to_browser: jobs.length });
  }

  const { data: cfg } = await db.from('app_settings').select('transcribe_language, transcribe_prompt').eq('id', 1).maybeSingle();
  const language = cfg?.transcribe_language ?? 'en';
  const prompt = cfg?.transcribe_prompt ?? '';
  let done = 0; const errors: string[] = [];
  for (const j of jobs) {
    try {
      let text = ''; let answeredBy: string | null = null;
      if (j.agent_path && j.caller_path) {
        const [a, c] = await Promise.all([groq(j.agent_path, language, prompt), groq(j.caller_path, language, prompt)]);
        const turns = mergeTurns([cleanSegments(a), cleanSegments(c)], ['Agent', 'Caller']);
        text = formatTurns(turns);
        answeredBy = detectAnsweredBy(turns);
      } else if (j.audio_path) {
        const segs = cleanSegments(await groq(j.audio_path, language, prompt));
        const turns = segs.map((s) => ({ at: s.start, end: s.end, who: '', text: s.text }));
        text = j.kind === 'voicemail' ? segs.map((s) => s.text).join(' ') : formatTurns(turns);
        answeredBy = j.kind === 'voicemail' ? null : detectAnsweredBy(turns, { labelled: false });
      } else throw new Error('no audio file');
      const { error: e2 } = await db.rpc('complete_transcription', { p_job: j.job_id, p_text: text, p_provider: 'groq', p_answered_by: answeredBy });
      if (e2) throw new Error(e2.message);
      done++;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      errors.push(msg);
      await db.rpc('fail_transcription', { p_job: j.job_id, p_error: msg, p_no_provider: false });
      if (e instanceof RateLimited) break;
    }
  }
  await setStatus(done ? { provider: 'groq', model: MODEL, last_ok_at: new Date().toISOString(), last_error: errors[0] ?? null } : { provider: 'groq', model: MODEL, last_error: errors[0] ?? null });
  return json({ ok: true, done, errors });
});
