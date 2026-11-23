// E2E test of the `team` function with throwaway users; cleans up after itself.
// Usage: node tests/e2e/team.mjs .env dashboard/config.js
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ANON = fs.readFileSync(process.argv[3], 'utf8').match(/eyJ[^']+/)[0];
const URL_ = env.SUPABASE_URL;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
const SR = keys.find((k) => k.name === 'service_role').api_key;
const sr = { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' };
const sql = async (query) => (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json();

const stamp = Date.now();
const mk = async (email, role) => {
  const pw = `Test${stamp}x9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: sr, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  await sql(`insert into profiles (user_id, role) values ('${u.id}', '${role}')`);
  const t = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json();
  return { id: u.id, jwt: t.access_token };
};
const call = async (jwt, body) => {
  const r = await fetch(`${URL_}/functions/v1/team`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const ok = (cond, label) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

const adminEmail = `e2e-admin-${stamp}@example.com`;
const mgrEmail = `e2e-mgr-${stamp}@example.com`;
const newEmail = `e2e-agent-${stamp}@example.com`;
const made = [];
try {
  const a = await mk(adminEmail, 'admin'); made.push(a.id);
  const m = await mk(mgrEmail, 'manager'); made.push(m.id);

  const c = await call(a.jwt, { action: 'create', email: newEmail, name: 'E2E Agent', role: 'agent', create_agent: true, account_type: 'workspace' });
  ok(c.ok && /^[A-Za-z0-9]{12}$/.test(c.temp_password) && /[A-Z]/.test(c.temp_password) && /\d/.test(c.temp_password), 'admin creates agent user with 12-char mixed temp password');
  ok(/^coco_[0-9a-f]{48}$/.test(c.agent_token || ''), 'agent token created in same step');
  if (c.user_id) made.push(c.user_id);

  const login = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newEmail, password: c.temp_password }) })).json();
  ok(!!login.access_token && login.user?.user_metadata?.must_change_password === true, 'new user can sign in with temp password and is flagged must_change_password');

  const ing = await (await fetch(`${URL_}/functions/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': c.agent_token }, body: JSON.stringify({ events: [], heartbeat: { health: {} } }) })).json();
  ok(ing.agent?.name === 'E2E Agent', 'extension token connects as "E2E Agent"');

  const dup = await call(a.jwt, { action: 'create', email: newEmail, role: 'agent' });
  ok(dup.status === 400 && /already exists/.test(dup.error), 'duplicate email rejected with clear message');

  const mAdmin = await call(m.jwt, { action: 'create', email: `x-${stamp}@example.com`, role: 'admin' });
  ok(mAdmin.status === 403, 'manager cannot create an admin');
  const mResetAdmin = await call(m.jwt, { action: 'reset_password', user_id: a.id });
  ok(mResetAdmin.status === 403, 'manager cannot reset an admin password');
  const mReset = await call(m.jwt, { action: 'reset_password', user_id: c.user_id });
  ok(mReset.ok && mReset.temp_password && mReset.temp_password !== c.temp_password, 'manager can reset an agent password');
  const mRole = await call(m.jwt, { action: 'set_role', user_id: c.user_id, role: 'admin' });
  ok(mRole.status === 403, 'manager cannot change roles');
  const self = await call(a.jwt, { action: 'remove', user_id: a.id });
  ok(self.status === 403, 'admin cannot remove themselves');
  const anon = await call(ANON, { action: 'create', email: `y-${stamp}@example.com` });
  ok(anon.status === 401, 'anonymous caller rejected');

  const rm = await call(m.jwt, { action: 'remove', user_id: c.user_id });
  ok(rm.ok, 'manager removes agent user');
  if (rm.ok) made.splice(made.indexOf(c.user_id), 1);
} finally {
  for (const id of made) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: sr });
  await sql("delete from agents where name = 'E2E Agent'");
  const left = await sql("select (select count(*) from auth.users where email like 'e2e-%@example.com') e2e_users, (select count(*) from agents) agents, (select count(*) from auth.users) users");
  console.log('cleanup:', JSON.stringify(left));
}
