// E2E test of the `team` function (Admin / Agent roles) with throwaway users; cleans up after itself.
// Usage: node tests/e2e/team.mjs .env dashboard/config.js
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ANON = fs.readFileSync(process.argv[3], 'utf8').match(/eyJ[^']+/)[0];
const URL_ = env.SUPABASE_URL;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
const SR = keys.find((k) => k.name === 'service_role').api_key;
const sr = { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' };
const sql = async (query) => (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json();
const signIn = async (email, password) => (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json());

const stamp = Date.now();
const mk = async (email, role) => {
  const pw = `Test${stamp}x9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: sr, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  await sql(`insert into profiles (user_id, role) values ('${u.id}', '${role}')`);
  return { id: u.id, jwt: (await signIn(email, pw)).access_token };
};
const call = async (jwt, body) => {
  const r = await fetch(`${URL_}/functions/v1/team`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const ok = (cond, label, detail = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  ↳ ${detail}` : ''}`);

const made = [];
try {
  const a = await mk(`e2e-admin-${stamp}@example.com`, 'admin'); made.push(a.id);
  const g = await mk(`e2e-plainagent-${stamp}@example.com`, 'agent'); made.push(g.id);

  // admin creates an agent user (login + tracking agent + token in one step)
  const agentEmail = `e2e-agent-${stamp}@example.com`;
  const c = await call(a.jwt, { action: 'create', email: agentEmail, name: 'E2E Agent', role: 'agent' });
  if (c.user_id) made.push(c.user_id);
  ok(c.ok && /^[A-Za-z0-9]{12}$/.test(c.temp_password) && /[A-Z]/.test(c.temp_password) && /\d/.test(c.temp_password), 'admin creates agent user with 12-char mixed temp password', JSON.stringify(c));
  ok(/^coco_[0-9a-f]{48}$/.test(c.agent_token || ''), 'agent token created in the same step');
  const [ag] = await sql("select account_type from agents where name = 'E2E Agent'");
  ok(ag?.account_type === 'workspace', 'new agent is a Google Voice business (workspace) account', JSON.stringify(ag));
  const login = await signIn(agentEmail, c.temp_password);
  ok(!!login.access_token && login.user?.user_metadata?.must_change_password === true, 'agent signs in with temp password and must change it');
  const ing = await (await fetch(`${URL_}/functions/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': c.agent_token }, body: JSON.stringify({ events: [], heartbeat: { health: {} } }) })).json();
  ok(ing.agent?.name === 'E2E Agent', 'agent token connects the extension as "E2E Agent"');

  // admin creates another admin
  const adminEmail = `e2e-admin2-${stamp}@example.com`;
  const c2 = await call(a.jwt, { action: 'create', email: adminEmail, name: 'E2E Admin 2', role: 'admin' });
  if (c2.user_id) made.push(c2.user_id);
  ok(c2.ok && c2.role === 'admin' && !c2.agent_token, 'admin creates another admin (no token)');

  ok((await call(a.jwt, { action: 'create', email: agentEmail, role: 'agent' })).status === 400, 'duplicate email rejected');
  ok((await call(g.jwt, { action: 'create', email: `x-${stamp}@example.com`, role: 'agent' })).status === 403, 'agent-role user cannot manage users');
  ok((await call(ANON, { action: 'create', email: `y-${stamp}@example.com` })).status === 401, 'anonymous caller rejected');
  ok((await call(a.jwt, { action: 'remove', user_id: a.id })).status === 400, 'admin cannot remove themselves');

  const rs = await call(a.jwt, { action: 'reset_password', user_id: c.user_id });
  ok(rs.ok && rs.temp_password && rs.temp_password !== c.temp_password, 'admin resets an agent password');
  ok((await call(a.jwt, { action: 'set_role', user_id: c2.user_id, role: 'agent' })).ok, 'admin changes a role (admin -> agent)');
  const rm = await call(a.jwt, { action: 'remove', user_id: c.user_id });
  ok(rm.ok, 'admin removes a user');
  if (rm.ok) made.splice(made.indexOf(c.user_id), 1);
} finally {
  for (const id of made) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: sr });
  await sql("delete from agents where name = 'E2E Agent'");
  const left = await sql("select (select count(*) from auth.users where email like 'e2e-%@example.com') e2e_users, (select count(*) from agents where name like 'E2E%') e2e_agents");
  console.log('cleanup:', JSON.stringify(left));
}
