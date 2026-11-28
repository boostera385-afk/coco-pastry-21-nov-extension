-- Vici Dialer (2026-11-28): calls made from the Vici agent screen (dm26.callengine.org), captured by the same
-- extension. Kept COMPLETELY SEPARATE from Google Voice: own table, own RPCs, own dashboard page. No Google Voice
-- view, metric, contact thread or analysis rule reads vici_calls. Vici has no SMS.
-- Recordings: the extension records the Vici browser phone per call (start/stop on Vici's own call events) and
-- uploads to the same `recordings` bucket / call_recordings table tagged source = 'vici' -> same Groq transcription.

alter table agents add column if not exists vici_user text;               -- Vici agent login (e.g. 8001), auto-detected
alter table agents add column if not exists vici_heartbeat_at timestamptz; -- separate from Google Voice "online"
alter table agents add column if not exists vici_health jsonb;

create table if not exists vici_calls (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references agents(id) on delete cascade,
  vici_uid          text not null,                 -- Vici/Asterisk uniqueid, or lead:<lead_id>:<start ms>
  vici_user         text,
  lead_id           text,
  phone             text,
  contact_name      text,
  campaign          text,
  direction         text check (direction in ('outbound', 'inbound')),
  dial_type         text check (dial_type in ('manual', 'auto', 'inbound', 'unknown')),
  disposition       text,                          -- Vici status the agent picked (SALE, NI, DNC, CALLBK, …)
  started_at        timestamptz not null,
  ended_at          timestamptz,
  talk_sec          int not null default 0,
  recording_path    text,
  transcript        text,
  transcript_source text,
  transcribed_at    timestamptz,
  answered_by       text check (answered_by in ('human', 'voicemail')),
  payload           jsonb,                         -- last raw event (re-parse later if the Vici map changes)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (agent_id, vici_uid)
);
create index if not exists vici_calls_agent_started on vici_calls (agent_id, started_at);
create index if not exists vici_calls_started on vici_calls (started_at);
alter table vici_calls enable row level security;
drop policy if exists "vici_calls: admins read" on vici_calls;
create policy "vici_calls: admins read" on vici_calls for select to authenticated using (is_admin());

alter table call_recordings add column if not exists source text not null default 'gv' check (source in ('gv', 'vici'));
alter table call_recordings add column if not exists vici_uid text;
alter table call_recordings add column if not exists vici_call_id uuid references vici_calls(id) on delete set null;
create index if not exists call_recordings_vici_unmatched on call_recordings (agent_id) where source = 'vici' and vici_call_id is null;

-- Google Voice matcher: never link a Vici recording to a Google Voice call.
create or replace function match_call_recordings(p_agent uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; v uuid; n int := 0;
begin
  for r in select * from call_recordings
            where agent_id = p_agent and source = 'gv' and call_id is null and started_at > now() - interval '7 days'
            order by started_at loop
    select k.id into v from calls k
     where k.agent_id = p_agent
       and k.occurred_at between r.started_at - interval '3 minutes' and r.started_at + interval '1 minute'
       and not exists (select 1 from call_recordings x where x.call_id = k.id)
     order by abs(extract(epoch from k.occurred_at - r.started_at)) limit 1;
    if v is not null then
      update call_recordings set call_id = v where id = r.id;
      update calls set recording_path = coalesce(recording_path, r.path),
                       transcript = coalesce(transcript, r.transcript),
                       transcript_source = case when transcript is null then r.transcript_source else transcript_source end,
                       answered_by = coalesce(answered_by, r.answered_by)
       where id = v;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function match_call_recordings(uuid) from public, anon, authenticated;

-- Vici recordings -> Vici calls: same call id first, otherwise closest start time.
create or replace function match_vici_recordings(p_agent uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; v uuid; n int := 0;
begin
  for r in select * from call_recordings
            where agent_id = p_agent and source = 'vici' and vici_call_id is null and started_at > now() - interval '7 days'
            order by started_at loop
    v := null;
    if r.vici_uid is not null then
      select k.id into v from vici_calls k where k.agent_id = p_agent and k.vici_uid = r.vici_uid;
    end if;
    if v is null then
      select k.id into v from vici_calls k
       where k.agent_id = p_agent
         and k.started_at between r.started_at - interval '2 minutes' and r.started_at + interval '1 minute'
         and not exists (select 1 from call_recordings x where x.vici_call_id = k.id)
       order by abs(extract(epoch from k.started_at - r.started_at)) limit 1;
    end if;
    if v is not null then
      update call_recordings set vici_call_id = v where id = r.id;
      update vici_calls set recording_path = coalesce(recording_path, r.path),
                            transcript = coalesce(transcript, r.transcript),
                            transcript_source = case when transcript is null then r.transcript_source else transcript_source end,
                            answered_by = coalesce(answered_by, r.answered_by),
                            talk_sec = greatest(talk_sec, r.duration_sec), updated_at = now()
       where id = v;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function match_vici_recordings(uuid) from public, anon, authenticated;

-- Extension -> server. Events are merged per call (start, end and disposition arrive separately).
create or replace function ingest_vici(p_agent uuid, p_user text, p_events jsonb, p_health jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e jsonb; v_ok int := 0; v_tz text := biz_tz(); v_t0 timestamptz;
begin
  update agents set vici_user = coalesce(nullif(left(p_user, 40), ''), vici_user), vici_heartbeat_at = now(),
         vici_health = coalesce(p_health, vici_health)
   where id = p_agent;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    continue when coalesce(e->>'vici_uid', '') = '' or (e->>'started_at') is null;
    insert into vici_calls as v (agent_id, vici_uid, vici_user, lead_id, phone, contact_name, campaign, direction, dial_type,
                                 disposition, started_at, ended_at, talk_sec, payload)
    values (p_agent, left(e->>'vici_uid', 80), nullif(left(e->>'vici_user', 40), ''), nullif(left(e->>'lead_id', 40), ''),
            nullif(left(e->>'phone', 30), ''), nullif(left(e->>'contact_name', 120), ''), nullif(left(e->>'campaign', 60), ''),
            case when e->>'direction' in ('outbound', 'inbound') then e->>'direction' end,
            case when e->>'dial_type' in ('manual', 'auto', 'inbound') then e->>'dial_type' else 'unknown' end,
            nullif(left(e->>'disposition', 30), ''), (e->>'started_at')::timestamptz, (e->>'ended_at')::timestamptz,
            greatest(0, least(6 * 3600, coalesce((e->>'talk_sec')::int, 0))), e)
    on conflict (agent_id, vici_uid) do update set
      vici_user    = coalesce(excluded.vici_user, v.vici_user),
      lead_id      = coalesce(excluded.lead_id, v.lead_id),
      phone        = coalesce(excluded.phone, v.phone),
      contact_name = coalesce(excluded.contact_name, v.contact_name),
      campaign     = coalesce(excluded.campaign, v.campaign),
      direction    = coalesce(excluded.direction, v.direction),
      dial_type    = case when excluded.dial_type = 'unknown' then v.dial_type else excluded.dial_type end,
      disposition  = coalesce(excluded.disposition, v.disposition),
      started_at   = least(v.started_at, excluded.started_at),
      ended_at     = coalesce(excluded.ended_at, v.ended_at),
      talk_sec     = greatest(v.talk_sec, excluded.talk_sec),
      payload      = excluded.payload,
      updated_at   = now();
    v_ok := v_ok + 1;
  end loop;
  perform match_vici_recordings(p_agent);
  v_t0 := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  return jsonb_build_object('accepted', v_ok, 'at', now(), 'today', (
    select jsonb_build_object('calls', count(*), 'connected', count(*) filter (where talk_sec > 0),
           'conversations', count(*) filter (where is_conversation(case when talk_sec > 0 then 'answered' end, talk_sec, answered_by)),
           'talkSec', coalesce(sum(talk_sec), 0))
      from vici_calls where agent_id = p_agent and started_at >= v_t0));
end $$;
revoke execute on function ingest_vici(uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- ---------- dashboard (Vici page only) ----------
create or replace function vici_summary(p_from date, p_to date, p_agent uuid default null,
                                        p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table (agent_id uuid, agent_name text, vici_user text, calls bigint, manual bigint, auto bigint, inbound bigint,
               connected bigint, conversations bigint, voicemails bigint, talk_sec bigint, recorded bigint,
               first_call_at timestamptz, last_call_at timestamptz, vici_heartbeat_at timestamptz)
language sql stable security definer set search_path = public as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1),
  k as (select v.* from vici_calls v, b where v.started_at >= b.t0 and v.started_at < b.t1)
  select a.id, a.name, a.vici_user, count(k.id),
         count(k.id) filter (where k.dial_type = 'manual'), count(k.id) filter (where k.dial_type = 'auto'),
         count(k.id) filter (where k.direction = 'inbound'),
         count(k.id) filter (where k.talk_sec > 0),
         count(k.id) filter (where is_conversation(case when k.talk_sec > 0 then 'answered' end, k.talk_sec, k.answered_by)),
         count(k.id) filter (where k.answered_by = 'voicemail'),
         coalesce(sum(k.talk_sec), 0), count(k.recording_path),
         min(k.started_at), max(k.started_at), a.vici_heartbeat_at
    from agents a left join k on k.agent_id = a.id
   where (is_admin() or a.id = my_agent_id()) and (p_agent is null or a.id = p_agent)
     and (a.vici_user is not null or a.vici_heartbeat_at is not null or k.id is not null)
   group by a.id, a.name, a.vici_user, a.vici_heartbeat_at
   order by count(k.id) desc, a.name
$$;
revoke execute on function vici_summary(date, date, uuid, timestamptz, timestamptz) from public, anon;

create or replace function vici_dispositions(p_from date, p_to date, p_agent uuid default null,
                                             p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table (disposition text, calls bigint, talk_sec bigint)
language sql stable security definer set search_path = public as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1)
  select coalesce(v.disposition, '(none)'), count(*), coalesce(sum(v.talk_sec), 0)
    from vici_calls v, b
   where v.started_at >= b.t0 and v.started_at < b.t1
     and (is_admin() or v.agent_id = my_agent_id()) and (p_agent is null or v.agent_id = p_agent)
   group by 1 order by 2 desc
$$;
revoke execute on function vici_dispositions(date, date, uuid, timestamptz, timestamptz) from public, anon;

create or replace function vici_calls_list(p_from date, p_to date, p_agent uuid default null,
                                           p_from_ts timestamptz default null, p_to_ts timestamptz default null,
                                           p_search text default null, p_limit int default 300)
returns table (id uuid, agent_id uuid, agent_name text, started_at timestamptz, phone text, contact_name text, lead_id text,
               campaign text, direction text, dial_type text, disposition text, talk_sec int, conversation boolean,
               answered_by text, recording_path text, transcript text, transcript_source text)
language sql stable security definer set search_path = public as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1)
  select v.id, v.agent_id, a.name, v.started_at, v.phone, v.contact_name, v.lead_id, v.campaign, v.direction, v.dial_type,
         v.disposition, v.talk_sec, is_conversation(case when v.talk_sec > 0 then 'answered' end, v.talk_sec, v.answered_by),
         v.answered_by,
         case when is_admin() then v.recording_path end, case when is_admin() then v.transcript end, v.transcript_source
    from vici_calls v cross join b join agents a on a.id = v.agent_id
   where v.started_at >= b.t0 and v.started_at < b.t1
     and (is_admin() or v.agent_id = my_agent_id()) and (p_agent is null or v.agent_id = p_agent)
     and (p_search is null or v.phone ilike '%' || p_search || '%' or v.contact_name ilike '%' || p_search || '%'
          or v.disposition ilike p_search or (is_admin() and v.transcript ilike '%' || p_search || '%'))
   order by v.started_at desc
   limit greatest(1, least(coalesce(p_limit, 300), 2000))
$$;
revoke execute on function vici_calls_list(date, date, uuid, timestamptz, timestamptz, text, int) from public, anon;

-- ---------- transcription: Vici recordings use the same jobs; results land on the Vici call ----------
create or replace function complete_transcription(p_job uuid, p_text text, p_provider text, p_answered_by text default null)
returns void language plpgsql security definer set search_path = public as $$
declare j transcription_jobs; t text := nullif(trim(coalesce(p_text, '')), ''); ab text := case when p_answered_by in ('human', 'voicemail') then p_answered_by end;
begin
  if not (is_admin() or coalesce(auth.role(), '') = 'service_role') then raise exception 'not allowed'; end if;
  select * into j from transcription_jobs where id = p_job;
  if not found then return; end if;
  t := coalesce(t, '(no speech detected)');
  if j.kind = 'recording' then
    update call_recordings set transcript = t, transcript_source = p_provider, answered_by = ab where id = j.ref_id;
    update calls c set transcript = t, transcript_source = p_provider, transcribed_at = now(), answered_by = coalesce(ab, c.answered_by)
      from call_recordings r where r.id = j.ref_id and r.source = 'gv' and c.id = r.call_id
       and (c.transcript is null or c.transcript_source in ('whisper', 'whisper-browser', 'groq') or c.transcript = '(no speech detected)');
    update vici_calls v set transcript = t, transcript_source = p_provider, transcribed_at = now(), answered_by = coalesce(ab, v.answered_by), updated_at = now()
      from call_recordings r where r.id = j.ref_id and r.source = 'vici' and v.id = r.vici_call_id;
  elsif j.kind = 'voicemail' then
    update messages set body = t, transcript_source = p_provider where id = j.ref_id and kind = 'voicemail';
  else
    update calls set transcript = t, transcript_source = p_provider, transcribed_at = now(), answered_by = coalesce(ab, answered_by) where id = j.ref_id;
  end if;
  update transcription_jobs set status = 'done', done_at = now(), provider = p_provider, error = null where id = p_job;
end $$;
revoke execute on function complete_transcription(uuid, text, text, text) from public, anon;

-- 'vici' = redo a Vici call (its recording job)
create or replace function retranscribe(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare k text := p_kind; rid uuid := p_id;
begin
  if not is_admin() then raise exception 'admins only'; end if;
  if p_kind = 'call' then  -- a call with Coco's own recording: redo the recording job
    select r.id into rid from call_recordings r where r.call_id = p_id limit 1;
    if rid is not null then k := 'recording'; else rid := p_id; end if;
  elsif p_kind = 'vici' then
    select r.id into rid from call_recordings r where r.vici_call_id = p_id limit 1;
    if rid is null then raise exception 'this Vici call has no recording'; end if;
    k := 'recording';
  end if;
  insert into transcription_jobs (kind, ref_id, agent_id) values (k, rid, null)
  on conflict (kind, ref_id) do update set status = 'pending', tries = 0, error = null, claimed_at = null, done_at = null;
end $$;
revoke execute on function retranscribe(text, uuid) from public, anon;

-- jobs list: + source ('gv' | 'vici'); Vici rows show the Vici call's time and phone
drop function if exists transcription_jobs_list(int);
create function transcription_jobs_list(p_limit int default 100)
returns table (job_id uuid, kind text, ref_id uuid, status text, tries int, error text, provider text, created_at timestamptz, done_at timestamptz,
               occurred_at timestamptz, duration_sec int, agent_name text, contact text, agent_id uuid, contact_id uuid, source text)
language sql stable security definer set search_path = public as $$
  select j.id, j.kind, j.ref_id, j.status, j.tries, j.error, j.provider, j.created_at, j.done_at,
         coalesce(c.occurred_at, vc.started_at, r.started_at, m.occurred_at, c2.occurred_at), coalesce(r.duration_sec, c2.duration_sec),
         a.name, coalesce(ct.phone_e164, vc.phone), a.id, coalesce(c.contact_id, m.contact_id, c2.contact_id),
         coalesce(r.source, 'gv')
    from transcription_jobs j
    left join call_recordings r on j.kind = 'recording' and r.id = j.ref_id
    left join calls c on c.id = r.call_id
    left join vici_calls vc on vc.id = r.vici_call_id
    left join messages m on j.kind = 'voicemail' and m.id = j.ref_id
    left join calls c2 on j.kind = 'call' and c2.id = j.ref_id
    left join agents a on a.id = coalesce(j.agent_id, r.agent_id, m.agent_id, c2.agent_id)
    left join contacts ct on ct.id = coalesce(c.contact_id, m.contact_id, c2.contact_id)
   where is_admin()
   order by (j.status = 'done'), j.created_at desc
   limit greatest(1, least(p_limit, 500))
$$;
revoke execute on function transcription_jobs_list(int) from public, anon;

-- live dashboard stamp also moves on Vici activity
create or replace function activity_version()
returns text language sql stable security definer set search_path = public as $$
  select concat_ws('|',
    (select max(created_at) from calls    where is_admin() or agent_id = my_agent_id()),
    (select max(transcribed_at) from calls where is_admin()),
    (select max(created_at) from messages where is_admin() or agent_id = my_agent_id()),
    (select max(created_at) from call_recordings where is_admin()),
    (select max(reviewed_at) from analysis_reviews where is_admin()),
    (select count(*) from analysis_reviews where is_admin()),
    (select max(last_heartbeat_at) from agents where is_admin() or id = my_agent_id()),
    (select max(updated_at) from vici_calls where is_admin() or agent_id = my_agent_id()))
$$;
revoke execute on function activity_version() from anon;
