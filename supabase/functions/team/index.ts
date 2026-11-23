// POST /functions/v1/team   (called from the dashboard with the signed-in admin's JWT)
// Only admins manage users. Roles: 'admin' (sees everything) and 'agent' (sees only their own numbers).
// New users get a temporary password and must choose their own at first sign-in.
// Creating an agent user also creates their tracking agent + extension token (or links an existing agent).
// All agents are Google Voice business (Workspace) accounts.
// Deploy: supabase functions deploy team
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** 12 chars, always has upper, lower and digits; no look-alike characters. */
function tempPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', all = U + L + D;
  const r = crypto.getRandomValues(new Uint32Array(12));
  const chars = [U[r[0] % U.length], L[r[1] % L.length], D[r[2] % D.length], D[r[3] % D.length]];
  for (let i = 4; i < 12; i++) chars.push(all[r[i] % all.length]);
  const s = crypto.getRandomValues(new Uint32Array(chars.length));
  for (let i = chars.length - 1; i > 0; i--) { const j = s[i] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function newAgentToken(name: string, email: string | null) {
  const token = 'coco_' + hex(crypto.getRandomValues(new Uint8Array(24)));
  const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
  const { data, error } = await admin.from('agents').insert({
    name, email, account_type: 'workspace', token_hash: hash, token_hint: token.slice(-4),
  }).select('id').single();
  if (error) throw new Error(error.message);
  return { agentId: data.id as string, token };
}
async function roleOf(userId: string): Promise<string | null> {
  const { data } = await admin.from('profiles').select('role').eq('user_id', userId).maybeSingle();
  return data?.role ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: me } = await admin.auth.getUser(jwt);
  if (!me?.user) return json({ error: 'Please sign in again.' }, 401);
  if ((await roleOf(me.user.id)) !== 'admin') return json({ error: 'Only admins can manage dashboard users.' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');
  const notSelf = (userId: string) => userId && userId !== me.user!.id;

  try {
    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const name = String(body.name ?? '').trim() || email.split('@')[0];
      const role = body.role === 'admin' ? 'admin' : 'agent';
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
      const password = tempPassword();
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name, must_change_password: true },
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message) ? 'A user with this email already exists. Use "Reset password" on their row instead.' : error.message;
        return json({ error: msg }, 400);
      }
      let agentId = role === 'agent' ? ((body.agent_id as string) || null) : null;
      let token: string | null = null;
      if (role === 'agent' && !agentId) ({ agentId, token } = await newAgentToken(name, email));
      const { error: pErr } = await admin.from('profiles').upsert({ user_id: created.user.id, role, agent_id: agentId });
      if (pErr) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: pErr.message }, 500); }
      return json({ ok: true, user_id: created.user.id, email, role, temp_password: password, agent_token: token });
    }

    if (action === 'set_role') {
      const userId = String(body.user_id ?? '');
      if (!notSelf(userId)) return json({ error: "You can't change your own role." }, 400);
      const role = body.role === 'admin' ? 'admin' : 'agent';
      const agentId = role === 'agent' ? ((body.agent_id as string) || null) : null;
      const { error } = await admin.from('profiles').upsert({ user_id: userId, role, agent_id: agentId });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'reset_password') {
      const userId = String(body.user_id ?? '');
      if (!notSelf(userId)) return json({ error: 'Use Account → change password for yourself.' }, 400);
      const password = tempPassword();
      const { data: u } = await admin.auth.admin.getUserById(userId);
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password, user_metadata: { ...(u?.user?.user_metadata ?? {}), must_change_password: true },
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, temp_password: password });
    }

    if (action === 'remove') {
      const userId = String(body.user_id ?? '');
      if (!notSelf(userId)) return json({ error: 'You can\'t remove yourself.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
