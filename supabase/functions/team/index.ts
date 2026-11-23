// POST /functions/v1/team   (called from the dashboard with the signed-in user's JWT)
// Admins: create/reset/remove any user and set any role.
// Managers: same, but only for users with role 'agent'.
// Creating an agent user can also create their tracking agent + extension token in one step.
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

const ROLES = ['admin', 'manager', 'agent'] as const;
type Role = typeof ROLES[number];

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}
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
async function newAgentToken(name: string, email: string | null, accountType: string) {
  const token = 'coco_' + hex(crypto.getRandomValues(new Uint8Array(24)));
  const { data, error } = await admin.from('agents').insert({
    name, email, account_type: accountType === 'workspace' ? 'workspace' : 'personal',
    token_hash: await sha256(token), token_hint: token.slice(-4),
  }).select('id').single();
  if (error) throw new Error(error.message);
  return { agentId: data.id as string, token };
}
async function roleOf(userId: string): Promise<Role | null> {
  const { data } = await admin.from('profiles').select('role').eq('user_id', userId).maybeSingle();
  return (data?.role as Role) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // --- who is calling? ---
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: me } = await admin.auth.getUser(jwt);
  if (!me?.user) return json({ error: 'Please sign in again.' }, 401);
  const myRole = await roleOf(me.user.id);
  if (myRole !== 'admin' && myRole !== 'manager') return json({ error: 'Only admins and managers can manage users.' }, 403);
  const isAdmin = myRole === 'admin';

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');

  // Managers may only act on agents.
  const canTouch = async (userId: string) => {
    if (userId === me.user!.id) return false;
    if (isAdmin) return true;
    return (await roleOf(userId)) === 'agent';
  };

  try {
    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? 'agent') as Role;
      const name = String(body.name ?? '').trim() || email.split('@')[0];
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
      if (!ROLES.includes(role)) return json({ error: 'Invalid role.' }, 400);
      if (!isAdmin && role !== 'agent') return json({ error: 'Managers can only create agent users.' }, 403);

      const password = tempPassword();
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, must_change_password: true },
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message) ? 'A user with this email already exists. Use "Reset password" on their row instead.' : error.message;
        return json({ error: msg }, 400);
      }

      let agentId = (body.agent_id as string) || null;
      let token: string | null = null;
      if (role === 'agent' && !agentId && body.create_agent !== false) {
        ({ agentId, token } = await newAgentToken(name, email, String(body.account_type ?? 'personal')));
      }
      const { error: pErr } = await admin.from('profiles').upsert({ user_id: created.user.id, role, agent_id: agentId });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: pErr.message }, 500);
      }
      return json({ ok: true, user_id: created.user.id, email, role, temp_password: password, agent_token: token });
    }

    if (action === 'reset_password') {
      const userId = String(body.user_id ?? '');
      if (!(await canTouch(userId))) return json({ error: 'You can\'t reset this user\'s password.' }, 403);
      const password = tempPassword();
      const { data: u } = await admin.auth.admin.getUserById(userId);
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password, user_metadata: { ...(u?.user?.user_metadata ?? {}), must_change_password: true },
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, temp_password: password });
    }

    if (action === 'set_role') {
      const userId = String(body.user_id ?? '');
      const role = String(body.role ?? '') as Role;
      if (!isAdmin) return json({ error: 'Only admins can change roles.' }, 403);
      if (userId === me.user.id) return json({ error: 'You can\'t change your own role.' }, 400);
      if (!ROLES.includes(role)) return json({ error: 'Invalid role.' }, 400);
      const { error } = await admin.from('profiles').upsert({ user_id: userId, role, agent_id: (body.agent_id as string) || null });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'remove') {
      const userId = String(body.user_id ?? '');
      if (!(await canTouch(userId))) return json({ error: 'You can\'t remove this user.' }, 403);
      const { error } = await admin.auth.admin.deleteUser(userId); // profile row cascades
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
