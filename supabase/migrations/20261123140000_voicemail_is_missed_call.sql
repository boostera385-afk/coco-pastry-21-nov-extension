-- A missed incoming call that goes to voicemail is stored by Google Voice ONLY as a voicemail (verified
-- 2026-11-23: no separate call record). Count such a voicemail as an incoming call that was missed, unless
-- an incoming call from the same number was already recorded in the 5 minutes before it (no double count).

create or replace view v_activity as
  select agent_id, contact_id, direction, 'call'::text as channel, occurred_at,
         (outcome in ('answered','connected') or duration_sec > 0) as connected, outcome,
         (outcome in ('answered','connected') and duration_sec >= conversation_sec()) as conversation,
         null::boolean as vm_call
    from calls
  union all
  select m.agent_id, m.contact_id, m.direction, case when m.kind = 'voicemail' then 'voicemail' else 'text' end,
         m.occurred_at, null, null, null,
         case when m.kind = 'voicemail' then not exists (
           select 1 from calls k where k.agent_id = m.agent_id and k.contact_id is not distinct from m.contact_id
              and k.direction = 'inbound' and k.occurred_at between m.occurred_at - interval '5 minutes' and m.occurred_at) end
    from messages m;
revoke all on v_activity from anon, authenticated;

CREATE OR REPLACE FUNCTION public.metrics_summary(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid)
 RETURNS TABLE(agent_id uuid, agent_name text, account_type text, gv_number text, outbound_total bigint, inbound_total bigint, contacts_reached bigint, outbound_calls bigint, connected_calls bigint, conversations bigint, outbound_texts bigint, inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint, response_rate numeric, avg_reply_min numeric, unclassified bigint, last_heartbeat_at timestamp with time zone, tracking_start timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (
    select (p_from::timestamp at time zone biz_tz()) as t0, ((p_to + 1)::timestamp at time zone biz_tz()) as t1
  ),
  scope as (select a.* from agents a where (is_admin() or a.id = my_agent_id()) and (p_agent is null or a.id = p_agent)),
  act as (
    select v.* from v_activity v, b
     where v.occurred_at >= b.t0 and v.occurred_at < b.t1 and v.agent_id in (select id from scope)
  ),
  counts as (
    select act.agent_id,
      count(*) filter (where direction = 'outbound' and channel in ('call','text'))               as outbound_total,
      count(*) filter (where direction = 'inbound')                                                as inbound_total,
      count(distinct contact_id) filter (where direction = 'outbound')                             as contacts_reached,
      count(*) filter (where channel = 'call' and direction = 'outbound')                          as outbound_calls,
      count(*) filter (where channel = 'call' and direction = 'outbound' and connected)            as connected_calls,
      count(*) filter (where channel = 'call' and direction = 'outbound' and conversation)         as conversations,
      count(*) filter (where channel = 'text' and direction = 'outbound')                          as outbound_texts,
      count(*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound')                           as inbound_calls,
      count(*) filter (where ((channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) or (channel = 'voicemail' and vm_call))) as missed_calls,
      count(*) filter (where channel = 'text' and direction = 'inbound')                           as inbound_texts,
      count(*) filter (where channel = 'voicemail')                                                as voicemails
    from act group by act.agent_id
  ),
  first_out as (
    select act.agent_id, act.contact_id, min(act.occurred_at) as t
      from act where direction = 'outbound' and contact_id is not null group by 1, 2
  ),
  resp as (
    select f.agent_id, round(100.0 * count(h.hit) / nullif(count(*), 0), 1) as response_rate
      from first_out f
      left join lateral (
        select 1 as hit from v_activity i
         where i.agent_id = f.agent_id and i.contact_id = f.contact_id and i.direction = 'inbound'
           and i.occurred_at > f.t and i.occurred_at <= f.t + interval '7 days'
         limit 1) h on true
     group by 1
  ),
  reply as (
    select i.agent_id, round(avg(extract(epoch from nx.t - i.occurred_at) / 60)::numeric, 1) as avg_reply_min
      from act i
      cross join lateral (
        select min(o.occurred_at) as t from v_activity o
         where o.agent_id = i.agent_id and o.contact_id = i.contact_id and o.direction = 'outbound'
           and o.occurred_at > i.occurred_at and o.occurred_at < i.occurred_at + interval '7 days') nx
     where i.direction = 'inbound' and nx.t is not null
     group by 1
  ),
  unc as (
    select u.agent_id, count(*) as n from unclassified_events u, b
     where u.occurred_at >= b.t0 and u.occurred_at < b.t1 group by 1
  )
  select s.id, s.name, s.account_type, s.gv_number,
         coalesce(c.outbound_total, 0), coalesce(c.inbound_total, 0), coalesce(c.contacts_reached, 0),
         coalesce(c.outbound_calls, 0), coalesce(c.connected_calls, 0), coalesce(c.conversations, 0), coalesce(c.outbound_texts, 0),
         coalesce(c.inbound_calls, 0), coalesce(c.missed_calls, 0), coalesce(c.inbound_texts, 0), coalesce(c.voicemails, 0),
         r.response_rate, rp.avg_reply_min, coalesce(u.n, 0), s.last_heartbeat_at, s.tracking_start
    from scope s
    left join counts c on c.agent_id = s.id
    left join resp r   on r.agent_id = s.id
    left join reply rp on rp.agent_id = s.id
    left join unc u    on u.agent_id = s.id
   order by coalesce(c.outbound_total, 0) desc, s.name
$function$;

CREATE OR REPLACE FUNCTION public.metrics_daily(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid)
 RETURNS TABLE(day date, outbound_total bigint, inbound_total bigint, outbound_calls bigint, outbound_texts bigint, inbound_calls bigint, missed_calls bigint, inbound_texts bigint, contacts_reached bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select biz_tz() as z),
  act as (
    select v.*, (v.occurred_at at time zone b.z)::date as d
      from v_activity v, b
     where (is_admin() or v.agent_id = my_agent_id())
       and v.occurred_at >= (p_from::timestamp at time zone b.z)
       and v.occurred_at <  ((p_to + 1)::timestamp at time zone b.z)
       and (p_agent is null or v.agent_id = p_agent)
  )
  select g.d::date,
    count(act.*) filter (where direction = 'outbound' and channel in ('call','text')),
    count(act.*) filter (where direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'outbound'),
    count(act.*) filter (where channel = 'text' and direction = 'outbound'),
    count(act.*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound'),
    count(act.*) filter (where ((channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) or (channel = 'voicemail' and vm_call))),
    count(act.*) filter (where channel = 'text' and direction = 'inbound'),
    count(distinct act.contact_id) filter (where direction = 'outbound')
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
  left join act on act.d = g.d::date
  group by g.d order by g.d
$function$;

CREATE OR REPLACE FUNCTION public.contact_activity(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text)
 RETURNS TABLE(contact_id uuid, contact text, contact_name text, agent_id uuid, agent_name text, conversation_id uuid, calls_out bigint, connected bigint, texts_out bigint, calls_in bigint, missed bigint, texts_in bigint, voicemails bigint, total bigint, first_at timestamp with time zone, last_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select (p_from::timestamp at time zone biz_tz()) as t0, ((p_to + 1)::timestamp at time zone biz_tz()) as t1),
  act as (
    select v.* from v_activity v, b
     where is_admin() and v.occurred_at >= b.t0 and v.occurred_at < b.t1
       and (p_agent is null or v.agent_id = p_agent) and v.contact_id is not null
  )
  select act.contact_id, c.phone_e164, c.name, act.agent_id, a.name,
         (select cv.id from conversations cv where cv.agent_id = act.agent_id and cv.contact_id = act.contact_id
           order by cv.last_activity_at desc nulls last limit 1),
         count(*) filter (where channel = 'call' and direction = 'outbound'),
         count(*) filter (where channel = 'call' and direction = 'outbound' and connected),
         count(*) filter (where channel = 'text' and direction = 'outbound'),
         count(*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound'),
         count(*) filter (where ((channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) or (channel = 'voicemail' and vm_call))),
         count(*) filter (where channel = 'text' and direction = 'inbound'),
         count(*) filter (where channel = 'voicemail'),
         count(*), min(act.occurred_at), max(act.occurred_at)
    from act
    join contacts c on c.id = act.contact_id
    join agents a on a.id = act.agent_id
   where p_search is null or c.phone_e164 ilike '%' || p_search || '%' or c.name ilike '%' || p_search || '%'
   group by act.contact_id, c.phone_e164, c.name, act.agent_id, a.name
   order by max(act.occurred_at) desc
   limit 500
$function$;

CREATE OR REPLACE FUNCTION public.contact_threads(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text)
 RETURNS TABLE(agent_id uuid, agent_name text, contact_id uuid, contact text, contact_name text, last_activity_at timestamp with time zone, calls_out bigint, picked_up bigint, conversations bigint, no_answer bigint, calls_in bigint, missed bigint, texts_out bigint, texts_in bigint, voicemails bigint, talk_sec bigint, last_text text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select (p_from::timestamp at time zone biz_tz()) t0, ((p_to + 1)::timestamp at time zone biz_tz()) t1),
  ev as (
    select k.agent_id, k.contact_id, 'call'::text ch, k.direction, k.outcome, k.duration_sec, k.occurred_at, null::text body, null::boolean vm_call
      from calls k, b where k.occurred_at >= b.t0 and k.occurred_at < b.t1
    union all
    select m.agent_id, m.contact_id, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, m.occurred_at, m.body,
           case when m.kind = 'voicemail' then not exists (select 1 from calls k2 where k2.agent_id = m.agent_id
             and k2.contact_id is not distinct from m.contact_id and k2.direction = 'inbound'
             and k2.occurred_at between m.occurred_at - interval '5 minutes' and m.occurred_at) end
      from messages m, b where m.occurred_at >= b.t0 and m.occurred_at < b.t1
  )
  select ev.agent_id, a.name, ev.contact_id, ct.phone_e164, ct.name, max(ev.occurred_at),
    count(*) filter (where ch = 'call' and direction = 'outbound'),
    count(*) filter (where ch = 'call' and direction = 'outbound' and (outcome in ('answered','connected') or duration_sec > 0)),
    count(*) filter (where ch = 'call' and direction = 'outbound' and outcome in ('answered','connected') and duration_sec >= conversation_sec()),
    count(*) filter (where ch = 'call' and direction = 'outbound' and coalesce(duration_sec, 0) = 0),
    count(*) filter (where (ch = 'call' or (ch = 'voicemail' and vm_call)) and direction = 'inbound'),
    count(*) filter (where ((ch = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) or (ch = 'voicemail' and vm_call))),
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
$function$;

CREATE OR REPLACE FUNCTION public.ingest_batch(p_agent uuid, p_agent_number text, p_parser text, p_events jsonb, p_health jsonb, p_client_start timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tz    text := biz_tz();
  v_start timestamptz;
  v_total int := coalesce(jsonb_array_length(p_events), 0);
  v_ok    int;
begin
  select tracking_start into v_start from agents where id = p_agent for update;
  if v_start is null then
    -- Tracking starts at the exact moment the agent connected (reported by the extension, accepted if
    -- within the last 7 days), otherwise now. No old history is ever imported.
    v_start := case when p_client_start between now() - interval '7 days' and now() + interval '5 minutes'
                    then least(p_client_start, now()) else now() end;
  end if;
  update agents set tracking_start = v_start, last_heartbeat_at = now(), last_health = p_health,
         parser_version = p_parser, gv_number = coalesce(nullif(p_agent_number, ''), gv_number)
   where id = p_agent;

  drop table if exists _ev;
  create temp table _ev on commit drop as
  select distinct on (e->>'gv_id')
         e->>'gv_id'                          as gv_id,
         coalesce(e->>'gv_thread_id', 'x.' || (e->>'gv_id')) as thread_id,
         e->>'type'                           as kind,
         e->>'direction'                      as direction,
         nullif(e->>'contact_number', '')     as phone,
         (e->>'occurred_at')::timestamptz     as occurred_at,
         e->>'body'                           as body,
         e->>'call_outcome'                   as outcome,
         greatest(coalesce((e->>'duration_sec')::int, 0), 0) as dur,
         e->'type_code'                       as type_code,
         e                                    as payload
    from jsonb_array_elements(p_events) e
   where e->>'gv_id' is not null
     and (e->>'occurred_at')::timestamptz >= v_start
   order by e->>'gv_id';
  select count(*) into v_ok from _ev;

  insert into raw_events (agent_id, gv_id, event_type, parser_version, payload)
  select p_agent, gv_id, coalesce(kind, 'unknown'), p_parser, payload from _ev;

  insert into contacts (phone_e164) select distinct phone from _ev where phone is not null
  on conflict (phone_e164) do nothing;

  insert into conversations (agent_id, contact_id, gv_thread_id, last_activity_at)
  select p_agent, (select c.id from contacts c where c.phone_e164 = min(ev.phone)), ev.thread_id, max(ev.occurred_at)
    from _ev ev group by ev.thread_id
  on conflict (agent_id, gv_thread_id) do update
     set last_activity_at = greatest(conversations.last_activity_at, excluded.last_activity_at),
         contact_id       = coalesce(conversations.contact_id, excluded.contact_id);

  insert into messages (agent_id, gv_id, conversation_id, contact_id, direction, kind, body, occurred_at)
  select p_agent, ev.gv_id, cv.id, ct.id, ev.direction,
         case when ev.kind = 'voicemail' then 'voicemail' else 'sms' end, ev.body, ev.occurred_at
    from _ev ev
    join conversations cv on cv.agent_id = p_agent and cv.gv_thread_id = ev.thread_id
    left join contacts ct on ct.phone_e164 = ev.phone
   where ev.kind in ('text','voicemail') and ev.direction in ('inbound','outbound')
  on conflict (agent_id, gv_id) do update
     set body = coalesce(excluded.body, messages.body), direction = excluded.direction;

  insert into calls (agent_id, gv_id, conversation_id, contact_id, direction, outcome, duration_sec, occurred_at)
  select p_agent, ev.gv_id, cv.id, ct.id, ev.direction,
         case when ev.direction = 'outbound' then (case when ev.dur > 0 then 'connected' else 'no_answer' end)
              when ev.outcome in ('answered','missed','voicemail','rejected') then ev.outcome
              when ev.dur > 0 then 'answered' else 'unknown' end,
         ev.dur, ev.occurred_at
    from _ev ev
    join conversations cv on cv.agent_id = p_agent and cv.gv_thread_id = ev.thread_id
    left join contacts ct on ct.phone_e164 = ev.phone
   where ev.kind = 'call' and ev.direction in ('inbound','outbound')
  on conflict (agent_id, gv_id) do update
     set outcome = excluded.outcome, duration_sec = greatest(calls.duration_sec, excluded.duration_sec);

  -- An item can be re-classified by a newer parser (e.g. call -> text). Keep it in exactly one table.
  delete from calls k using _ev ev
   where k.agent_id = p_agent and k.gv_id = ev.gv_id and ev.kind in ('text','voicemail') and ev.direction in ('inbound','outbound');
  delete from messages m using _ev ev
   where m.agent_id = p_agent and m.gv_id = ev.gv_id and ev.kind = 'call' and ev.direction in ('inbound','outbound');
  delete from unclassified_events u using _ev ev
   where u.agent_id = p_agent and u.gv_id = ev.gv_id and ev.kind in ('text','voicemail','call') and ev.direction in ('inbound','outbound');

  insert into unclassified_events (agent_id, gv_id, type_code, occurred_at, payload)
  select p_agent, gv_id, type_code, occurred_at, payload from _ev
   where kind not in ('text','voicemail','call') or kind is null or direction not in ('inbound','outbound') or direction is null
  on conflict (agent_id, gv_id) do update set payload = excluded.payload, type_code = excluded.type_code;

  -- Server-side counts for the extension panel (single source of truth = database)
  return jsonb_build_object(
    'accepted', v_ok, 'skipped_before_tracking_start', v_total - v_ok,
    'config', jsonb_build_object('timezone', v_tz, 'tracking_start', v_start),
    'summary', (
      select jsonb_object_agg(w.name, (
        select jsonb_build_object(
          'outboundTotal',  count(*) filter (where direction = 'outbound' and channel in ('call','text')),
          'inboundTotal',   count(*) filter (where direction = 'inbound'),
          'contactsReached',count(distinct contact_id) filter (where direction = 'outbound'),
          'outboundCalls',  count(*) filter (where channel = 'call' and direction = 'outbound'),
          'connectedCalls', count(*) filter (where channel = 'call' and direction = 'outbound' and connected),
          'conversations',  count(*) filter (where channel = 'call' and direction = 'outbound' and conversation),
          'outboundTexts',  count(*) filter (where channel = 'text' and direction = 'outbound'),
          'inboundCalls',   count(*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound'),
          'missedCalls',    count(*) filter (where ((channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) or (channel = 'voicemail' and vm_call))),
          'inboundTexts',   count(*) filter (where channel = 'text' and direction = 'inbound'),
          'voicemails',     count(*) filter (where channel = 'voicemail'))
          from v_activity v
         where v.agent_id = p_agent
           and v.occurred_at >= ((now() at time zone v_tz)::date - w.days + 1)::timestamp at time zone v_tz))
      from (values ('today', 1), ('7d', 7), ('30d', 30)) w(name, days)),
    'at', now());
end $function$;

revoke execute on function ingest_batch(uuid, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
