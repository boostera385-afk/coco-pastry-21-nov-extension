// Re-runs the CURRENT extension parser over raw events already stored in Supabase and re-ingests them.
// Use after fixing FIELD_MAP so old, mis-classified rows are corrected (ingest moves rows between tables).
// Usage: node scripts/reparse.mjs [--dry]      (reads SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF from .env)
import fs from 'node:fs';
import { parseResponse, PARSER_VERSION } from '../extension/src/parser/gv-protojson.js';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const dry = process.argv.includes('--dry');

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok || j.message) throw new Error(j.message || r.status);
  return j;
}

// latest raw copy per (agent, gv_id)
const rows = await sql(`
  select distinct on (r.agent_id, r.gv_id) r.agent_id, a.gv_number, r.payload
    from raw_events r join agents a on a.id = r.agent_id
   where r.payload ? 'raw'
   order by r.agent_id, r.gv_id, r.received_at desc`);

const byAgent = new Map();
for (const { agent_id: agentId, gv_number: agentNumber, payload } of rows) {
  const thread = payload.gv_thread_id || `x.${payload.gv_id}`;
  const body = JSON.stringify([[[thread, 1, [payload.raw]]]]);
  const { events } = parseResponse('https://x/voiceclient/api2thread/list', body, { agentNumber });
  for (const e of events) {
    const before = `${payload.type}/${payload.direction}`;
    const after = `${e.type}/${e.direction}`;
    console.log(`${e.gv_id.slice(0, 10)}…  ${before.padEnd(18)} -> ${after}${before === after ? '' : '   (changed)'}`);
    if (!byAgent.has(agentId)) byAgent.set(agentId, { agentNumber, events: [] });
    byAgent.get(agentId).events.push(e);
  }
}

if (dry) { console.log('dry run: nothing written'); process.exit(0); }
for (const [agentId, { agentNumber, events }] of byAgent) {
  const json = JSON.stringify(events).replaceAll('$coco$', '');
  const out = await sql(`select ingest_batch('${agentId}', ${agentNumber ? `'${agentNumber}'` : 'null'}, '${PARSER_VERSION}', $coco$${json}$coco$::jsonb, null)`);
  console.log(`agent ${agentId}: ${JSON.stringify(out[0].ingest_batch)}`);
}
