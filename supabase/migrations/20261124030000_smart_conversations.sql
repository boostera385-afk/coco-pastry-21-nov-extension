-- Smarter "conversation" (2026-11-24): a call is a conversation when the transcript shows a real person talking with
-- the agent (both sides spoke, not a voicemail greeting), even if it was short. Without a transcript: answered and
-- at least analysis_rules.conversation_sec long (as before). A call that reached voicemail is never a conversation.
alter table calls add column if not exists answered_by text check (answered_by in ('human', 'voicemail'));
alter table call_recordings add column if not exists answered_by text check (answered_by in ('human', 'voicemail'));

create or replace function is_conversation(p_outcome text, p_duration int, p_answered_by text)
returns boolean language sql stable set search_path = public as $$
  select case
    when p_answered_by = 'human' then true
    when p_answered_by = 'voicemail' then false
    else p_outcome in ('answered', 'connected') and coalesce(p_duration, 0) >= conversation_sec()
  end
$$;

CREATE OR REPLACE FUNCTION public.activity_log(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(occurred_at timestamp with time zone, local_time text, agent_name text, contact text, contact_name text, channel text, direction text, outcome text, duration_sec integer, conversation boolean, body text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1, biz_tz() z),
  ev as (
    select k.agent_id, k.contact_id, 'call'::text ch, k.direction,
           case when k.direction = 'outbound' then (case when k.duration_sec > 0 then 'picked up (person, voicemail or bot)' else 'no answer' end)
                else coalesce(k.outcome, 'unknown') end oc,
           k.duration_sec, is_conversation(k.outcome, k.duration_sec, k.answered_by) conv, k.occurred_at, null::text body
      from calls k, b where k.occurred_at >= b.t0 and k.occurred_at < b.t1
    union all
    select m.agent_id, m.contact_id, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction,
           case when m.direction = 'outbound' then 'sent' else 'received' end, null, null, m.occurred_at, m.body
      from messages m, b where m.occurred_at >= b.t0 and m.occurred_at < b.t1
  )
  select ev.occurred_at, to_char(ev.occurred_at at time zone b.z, 'YYYY-MM-DD HH24:MI:SS'), a.name, ct.phone_e164, ct.name,
         ev.ch, ev.direction, ev.oc, ev.duration_sec, ev.conv, case when is_manager() then ev.body end
    from ev cross join b
    join agents a on a.id = ev.agent_id
    left join contacts ct on ct.id = ev.contact_id
   where (is_admin() or ev.agent_id = my_agent_id())
     and (p_agent is null or ev.agent_id = p_agent)
   order by ev.occurred_at
   limit 20000
$function$
;


CREATE OR REPLACE FUNCTION public.contact_threads(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_id uuid, agent_name text, contact_id uuid, contact text, contact_name text, last_activity_at timestamp with time zone, calls_out bigint, picked_up bigint, conversations bigint, no_answer bigint, calls_in bigint, missed bigint, texts_out bigint, texts_in bigint, voicemails bigint, talk_sec bigint, last_text text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1),
  ev as (
    select k.agent_id, k.contact_id, 'call'::text ch, k.direction, k.outcome, k.duration_sec, k.occurred_at, null::text body, null::boolean vm_call, is_conversation(k.outcome, k.duration_sec, k.answered_by) conv
      from calls k, b where k.occurred_at >= b.t0 and k.occurred_at < b.t1
    union all
    select m.agent_id, m.contact_id, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, m.occurred_at, m.body,
           case when m.kind = 'voicemail' then not exists (select 1 from calls k2 where k2.agent_id = m.agent_id
             and k2.contact_id is not distinct from m.contact_id and k2.direction = 'inbound'
             and k2.occurred_at between m.occurred_at - interval '5 minutes' and m.occurred_at) end, null::boolean
      from messages m, b where m.occurred_at >= b.t0 and m.occurred_at < b.t1
  )
  select ev.agent_id, a.name, ev.contact_id, ct.phone_e164, ct.name, max(ev.occurred_at),
    count(*) filter (where ch = 'call' and direction = 'outbound'),
    count(*) filter (where ch = 'call' and direction = 'outbound' and (outcome in ('answered','connected') or duration_sec > 0)),
    count(*) filter (where ch = 'call' and direction = 'outbound' and conv),
    count(*) filter (where ch = 'call' and direction = 'outbound' and coalesce(duration_sec, 0) = 0),
    count(*) filter (where (ch = 'call' or (ch = 'voicemail' and vm_call)) and direction = 'inbound'),
    count(*) filter (where (ch = 'call' and direction = 'inbound' and outcome = 'missed')),
    count(*) filter (where ch = 'text' and direction = 'outbound'),
    count(*) filter (where ch = 'text' and direction = 'inbound'),
    count(*) filter (where ch = 'voicemail'),
    coalesce(sum(duration_sec) filter (where ch = 'call'), 0),
    (array_agg(body order by occurred_at desc) filter (where nullif(body, '') is not null))[1]
  from ev
  join agents a on a.id = ev.agent_id
  left join contacts ct on ct.id = ev.contact_id
  where is_manager()
    and (p_agent is null or ev.agent_id = p_agent)
    and (p_search is null or ct.phone_e164 ilike '%' || p_search || '%' or ct.name ilike '%' || p_search || '%'
         or exists (select 1 from messages m where m.agent_id = ev.agent_id and m.contact_id is not distinct from ev.contact_id
                     and m.body ilike '%' || p_search || '%'))
  group by ev.agent_id, a.name, ev.contact_id, ct.phone_e164, ct.name
  order by max(ev.occurred_at) desc
  limit 300
$function$
;


create or replace view v_activity as
 SELECT calls.agent_id,
    calls.contact_id,
    calls.direction,
    'call'::text AS channel,
    calls.occurred_at,
    ((calls.outcome = ANY (ARRAY['answered'::text, 'connected'::text])) OR (calls.duration_sec > 0)) AS connected,
    calls.outcome,
    is_conversation(calls.outcome, calls.duration_sec, calls.answered_by) AS conversation,
    NULL::boolean AS vm_call
   FROM calls
UNION ALL
 SELECT m.agent_id,
    m.contact_id,
    m.direction,
        CASE
            WHEN (m.kind = 'voicemail'::text) THEN 'voicemail'::text
            ELSE 'text'::text
        END AS channel,
    m.occurred_at,
    NULL::boolean AS connected,
    NULL::text AS outcome,
    NULL::boolean AS conversation,
        CASE
            WHEN (m.kind = 'voicemail'::text) THEN (NOT (EXISTS ( SELECT 1
               FROM calls k
              WHERE ((k.agent_id = m.agent_id) AND (NOT (k.contact_id IS DISTINCT FROM m.contact_id)) AND (k.direction = 'inbound'::text) AND ((k.occurred_at >= (m.occurred_at - '00:05:00'::interval)) AND (k.occurred_at <= m.occurred_at))))))
            ELSE NULL::boolean
        END AS vm_call
   FROM messages m;

drop function if exists contact_timeline(uuid, uuid);
create function contact_timeline(p_agent uuid, p_contact uuid)
returns table (id uuid, kind text, direction text, outcome text, duration_sec int, conversation boolean, body text,
               occurred_at timestamptz, recording_path text, transcript_source text, answered_by text)
language sql stable security definer set search_path = public as $$
  select k.id, 'call', k.direction,
         case when k.direction = 'outbound' then (case when k.duration_sec > 0 then 'connected' else 'no_answer' end) else k.outcome end,
         k.duration_sec, is_conversation(k.outcome, k.duration_sec, k.answered_by), k.transcript, k.occurred_at,
         k.recording_path, k.transcript_source, k.answered_by
    from calls k where is_manager() and k.agent_id = p_agent and k.contact_id is not distinct from p_contact
  union all
  select m.id, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, null, m.body, m.occurred_at,
         m.recording_path, m.transcript_source, null
    from messages m where is_manager() and m.agent_id = p_agent and m.contact_id is not distinct from p_contact
  order by occurred_at
$$;

-- transcripts carry who answered (decided from the transcript by the transcriber)
drop function if exists complete_transcription(uuid, text, text);
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
      from call_recordings r where r.id = j.ref_id and c.id = r.call_id
       and (c.transcript is null or c.transcript_source in ('whisper', 'whisper-browser', 'groq') or c.transcript = '(no speech detected)');
  elsif j.kind = 'voicemail' then
    update messages set body = t, transcript_source = p_provider where id = j.ref_id and kind = 'voicemail';
  else
    update calls set transcript = t, transcript_source = p_provider, transcribed_at = now(), answered_by = coalesce(ab, answered_by) where id = j.ref_id;
  end if;
  update transcription_jobs set status = 'done', done_at = now(), provider = p_provider, error = null where id = p_job;
end $$;
revoke execute on function complete_transcription(uuid, text, text, text) from public, anon;

-- linking a recording to its call later also copies who answered
create or replace function match_call_recordings(p_agent uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; v uuid; n int := 0;
begin
  for r in select * from call_recordings
            where agent_id = p_agent and call_id is null and started_at > now() - interval '7 days'
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
