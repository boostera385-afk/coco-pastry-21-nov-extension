// POST /functions/v1/ingest   header: x-agent-token: coco_...
// Deploy with:  supabase functions deploy ingest --no-verify-jwt
// (the extension authenticates with its per-agent token, not a Supabase JWT)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-agent-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = req.headers.get('x-agent-token') ?? '';
  if (!/^coco_[0-9a-f]{48}$/.test(token)) return json({ error: 'missing or malformed token' }, 401);

  const { data: agent, error: agentErr } = await supabase
    .from('agents').select('id, active, name, record_calls').eq('token_hash', await sha256(token)).maybeSingle();
  if (agentErr) return json({ error: 'lookup failed' }, 500);
  if (!agent) return json({ error: 'invalid token' }, 401);
  if (!agent.active) return json({ error: 'deactivated', message: 'Tracking is turned off for this agent by your admin' }, 403);

  const params = new URL(req.url).searchParams;
  const audioExt = (type: string) => (type.includes('mpeg') || type.includes('mp3') ? 'mp3' : type.includes('mp4') || type.includes('aac') ? 'm4a'
    : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : type.includes('webm') ? 'webm' : type.includes('amr') ? 'amr' : 'bin');
  // Automatic transcription runs in the background (the extension gets its answer right away).
  const kickTranscription = () => {
    const run = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/transcribe`, {
      method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max: 3 }),
    }).then((r) => r.body?.cancel()).catch(() => {});
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(run);
  };
  const saveRecordings = async () => {
    const { data: cfg } = await supabase.from('app_settings').select('save_recordings').eq('id', 1).maybeSingle();
    return !(cfg && cfg.save_recordings === false);
  };

  // ---- call recording made by the extension itself: POST ?rec=<uuid>&start=<iso>&dur=<sec>[&part=agent|caller] ----
  // The mixed stereo file (for playback) is sent first, then one mono file per speaker (for labelled transcripts).
  const rec = params.get('rec');
  if (rec !== null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rec)) return json({ error: 'bad recording id' }, 400);
    const start = Date.parse(params.get('start') ?? '');
    if (!Number.isFinite(start) || start > Date.now() + 5 * 60e3) return json({ error: 'bad start time' }, 400);
    const dur = Math.max(0, Math.min(6 * 3600, Math.round(Number(params.get('dur')) || 0)));
    if (agent.record_calls === false || !(await saveRecordings())) return json({ ok: true, skipped: 'call recording is turned off by the admin' });
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!/^audio\//.test(type)) return json({ error: 'audio only' }, 415);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) return json({ error: 'empty or too large (25 MB max)' }, 413);
    const part = params.get('part');
    if (part !== null && part !== 'agent' && part !== 'caller') return json({ error: 'bad part' }, 400);
    // Vici Dialer recordings stay separate from Google Voice (own matcher, never linked to a Google Voice call)
    const source = params.get('source') === 'vici' ? 'vici' : 'gv';
    const viciUid = source === 'vici' ? (params.get('vuid') ?? '').slice(0, 80) || null : null;
    const path = `${agent.id}/rec-${rec}${part ? `-${part}` : ''}.${audioExt(type)}`;
    const up = await supabase.storage.from('recordings').upload(path, bytes, { contentType: type, upsert: true });
    if (up.error) return json({ error: `storage: ${up.error.message}` }, 500);
    if (part) {
      const upd = await supabase.from('call_recordings').update({ [`${part}_path`]: path }).eq('id', rec).eq('agent_id', agent.id).select('agent_path, caller_path');
      if (upd.error) return json({ error: upd.error.message }, 500);
      if (!upd.data?.length) return json({ error: 'upload the mixed recording first' }, 409);
      if (upd.data[0].agent_path && upd.data[0].caller_path) kickTranscription(); // both sides in: transcribe now
      return json({ ok: true, path });
    }
    const ins = await supabase.from('call_recordings').upsert({ id: rec, agent_id: agent.id, started_at: new Date(start).toISOString(),
      duration_sec: dur, bytes: bytes.length, path, source, vici_uid: viciUid }, { onConflict: 'id' });
    if (ins.error) return json({ error: ins.error.message }, 500);
    const { data: matched } = await supabase.rpc(source === 'vici' ? 'match_vici_recordings' : 'match_call_recordings', { p_agent: agent.id });
    return json({ ok: true, path, matched: matched ?? 0 });
  }

  // ---- audio upload: POST ?media=<gv_id>  (voicemail / call recording copied by the extension) ----
  const media = params.get('media');
  if (media !== null) {
    if (!/^[A-Za-z0-9_.-]{6,80}$/.test(media)) return json({ error: 'bad media id' }, 400);
    // admin switch (Dashboard -> Settings): when off, audio is not stored; the extension stops retrying
    if (!(await saveRecordings())) return json({ ok: true, skipped: 'recording storage is turned off by the admin' });
    const type = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!/^audio\/|^application\/octet-stream$/.test(type)) return json({ error: 'audio only' }, 415);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) return json({ error: 'empty or too large (25 MB max)' }, 413);
    const ext = audioExt(type);
    const path = `${agent.id}/${media}.${ext}`;
    const up = await supabase.storage.from('recordings').upload(path, bytes, { contentType: type, upsert: true });
    if (up.error) return json({ error: `storage: ${up.error.message}` }, 500);
    const { data: rows, error: attErr } = await supabase.rpc('attach_recording', { p_agent: agent.id, p_gv_id: media, p_path: path });
    if (attErr) return json({ error: attErr.message }, 500);
    kickTranscription(); // voicemail / Google call recording without Google's own transcript
    return json({ ok: true, path, attached: rows });
  }

  // ---- Vici Dialer calls: POST ?vici=1  { vici_user, events, health }  (separate table, never mixed with Google Voice) ----
  if (params.get('vici') !== null) {
    let vb: { vici_user?: string; events?: unknown[]; health?: unknown };
    try { vb = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
    const { data, error } = await supabase.rpc('ingest_vici', {
      p_agent: agent.id,
      p_user: typeof vb.vici_user === 'string' ? vb.vici_user : null,
      p_events: Array.isArray(vb.events) ? vb.events.slice(0, 500) : [],
      p_health: vb.health ?? null,
    });
    if (error) return json({ error: error.message }, 500);
    const recordCalls = agent.record_calls !== false && (await saveRecordings());
    return json({ ...data, config: { record_calls: recordCalls }, agent: { name: agent.name } });
  }

  let body: {
    events?: unknown[]; agent_number?: string; parser_version?: string;
    tracking_start?: string; heartbeat?: { health?: unknown };
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];

  const { data, error } = await supabase.rpc('ingest_batch', {
    p_agent: agent.id,
    p_agent_number: typeof body.agent_number === 'string' ? body.agent_number : null,
    p_parser: String(body.parser_version ?? 'unknown').slice(0, 40),
    p_events: events,
    p_health: body.heartbeat?.health ?? null,
    p_client_start: typeof body.tracking_start === 'string' ? body.tracking_start : null,
  });
  if (error) return json({ error: error.message }, 500);
  // recordings uploaded before their call was synced get linked now (cheap: only unmatched rows)
  if (events.length) await supabase.rpc('match_call_recordings', { p_agent: agent.id });
  // catch-up: anything still waiting (older recordings, retries after a Groq hiccup) gets another go
  const { count: waiting } = await supabase.from('transcription_jobs').select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'failed', 'working']).lt('tries', 4);
  if (waiting) kickTranscription();
  const recordCalls = agent.record_calls !== false && (await saveRecordings());
  return json({ ...data, config: { ...(data?.config ?? {}), record_calls: recordCalls }, agent: { name: agent.name } });
});
