// Audio upload check against the REAL backend: throwaway agent ingests a voicemail, uploads audio via
// ingest?media=, verifies storage + row link + admin-only read, then deletes everything.
// Usage: node tests/e2e/media.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.SUPABASE_URL;
const ANON = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8').match(/eyJ[^']+/)[0];
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json(); if (!r.ok || j.message) throw new Error(j.message || r.status); return j;
};
let fails = 0;
const check = (name, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${d}`}`); };

const keys = await (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } })).json();
const SR = keys.find((k) => k.name === 'service_role').api_key;
const token = `coco_${crypto.randomBytes(24).toString('hex')}`;
const [{ id: agentId }] = await sql(`insert into agents (name, token_hash, token_hint, account_type) values ('E2E Media', '${crypto.createHash('sha256').update(token).digest('hex')}', '${token.slice(-4)}', 'workspace') returning id`);
const users = [];
const mkUser = async (role) => {
  const email = `e2e-media-${role}-${Date.now()}@example.com`; const pw = `E2e${crypto.randomBytes(6).toString('hex')}9`;
  const u = await (await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, email_confirm: true }) })).json();
  users.push(u.id);
  await sql(`insert into profiles (user_id, role, agent_id) values ('${u.id}', '${role}', ${role === 'agent' ? `'${agentId}'` : 'null'})`);
  return (await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json()).access_token;
};
const ING = `${URL_}/functions/v1/ingest`;
try {
  const gv = `E2EVM${crypto.randomBytes(6).toString('hex')}`;
  const ev = { type: 'voicemail', gv_id: gv, gv_thread_id: `c.${gv}`, agent_number: '+15550001111', contact_number: '+15550009999', direction: 'inbound',
    occurred_at: new Date().toISOString(), body: 'please call me back', call_outcome: null, duration_sec: 7, type_code: 2, media_url: 'https://www.google.com/voice/media/svm/x' };
  const r1 = await fetch(ING, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-token': token }, body: JSON.stringify({ parser_version: 'e2e', tracking_start: new Date(Date.now() - 60e3).toISOString(), events: [ev] }) });
  check('voicemail event ingested', r1.ok && (await r1.json()).accepted === 1);

  const audio = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(2048)]);
  const bad = await fetch(`${ING}?media=${gv}`, { method: 'POST', headers: { 'x-agent-token': 'coco_' + '0'.repeat(48), 'Content-Type': 'audio/mpeg' }, body: audio });
  check('upload with a wrong token is rejected (401)', bad.status === 401);
  const notAudio = await fetch(`${ING}?media=${gv}`, { method: 'POST', headers: { 'x-agent-token': token, 'Content-Type': 'text/html' }, body: '<html>' });
  check('non-audio upload is rejected (415)', notAudio.status === 415);
  const up = await fetch(`${ING}?media=${gv}`, { method: 'POST', headers: { 'x-agent-token': token, 'Content-Type': 'audio/mpeg' }, body: audio });
  const upj = await up.json();
  check('audio upload stored and linked to the voicemail', up.ok && upj.attached === 1 && upj.path === `${agentId}/${gv}.mp3`, JSON.stringify(upj));
  const [row] = await sql(`select recording_path from messages where agent_id='${agentId}' and gv_id='${gv}'`);
  check('messages.recording_path set', row?.recording_path === `${agentId}/${gv}.mp3`);

  const admin = await mkUser('admin');
  const agent = await mkUser('agent');
  const sign = (jwt) => fetch(`${URL_}/storage/v1/object/sign/recordings/${agentId}/${gv}.mp3`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }) });
  const sa = await sign(admin); const saj = await sa.json();
  const dl = saj.signedURL ? await fetch(`${URL_}/storage/v1${saj.signedURL}`) : null;
  const got = dl ? Buffer.from(await dl.arrayBuffer()) : Buffer.alloc(0);
  check('admin can play the audio (signed link returns the same bytes)', got.equals(audio), JSON.stringify(saj).slice(0, 120));
  const sg = await sign(agent);
  check('agent-role user cannot get the audio', !sg.ok, String(sg.status));
  const anon = await fetch(`${URL_}/storage/v1/object/public/recordings/${agentId}/${gv}.mp3`);
  check('bucket is not public', !anon.ok);
} catch (e) { check('run', false, e.stack); } finally {
  await fetch(`${URL_}/storage/v1/object/recordings`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: (await (await fetch(`${URL_}/storage/v1/object/list/recordings`, { method: 'POST', headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: agentId }) })).json()).map((o) => `${agentId}/${o.name}`) }) }).catch(() => {});
  for (const id of users) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).catch(() => {});
  await sql(`delete from agents where id='${agentId}'`).catch(() => {});
  await sql("delete from contacts c where phone_e164='+15550009999' and not exists (select 1 from messages m where m.contact_id=c.id) and not exists (select 1 from calls k where k.contact_id=c.id) and not exists (select 1 from conversations v where v.contact_id=c.id)").catch(() => {});
  const left = await sql(`select (select count(*) from agents where id='${agentId}') a, (select count(*) from storage.objects where name like '${agentId}/%') o`);
  console.log(`cleanup: ${JSON.stringify(left)}`);
  console.log(fails ? `\n${fails} failed` : '\nall media checks passed');
  process.exitCode = fails ? 1 : 0;
}
