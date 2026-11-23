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
    .from('agents').select('id, active').eq('token_hash', await sha256(token)).maybeSingle();
  if (agentErr) return json({ error: 'lookup failed' }, 500);
  if (!agent || !agent.active) return json({ error: 'invalid or inactive token' }, 401);

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
  return json(data);
});
