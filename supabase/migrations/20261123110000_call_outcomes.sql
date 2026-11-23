-- Honest outgoing-call outcomes (best practice for dialers without answer detection).
-- Google Voice cannot tell a person from voicemail / an IVR bot on OUTGOING calls, so:
--   connected  = the call was picked up (person, voicemail or bot) -> duration > 0
--   no_answer  = it never connected (0 s: rang out, busy, cancelled)
--   conversation = connected AND lasted >= analysis_rules.conversation_sec (default 60 s)
-- 'answered' stays for INCOMING calls only.

alter table calls drop constraint if exists calls_outcome_check;
alter table calls add constraint calls_outcome_check
  check (outcome in ('answered','connected','no_answer','missed','voicemail','rejected','unknown'));

update calls set outcome = case when duration_sec > 0 then 'connected' else 'no_answer' end
 where direction = 'outbound' and outcome in ('answered','unknown');

update app_settings set analysis_rules = coalesce(analysis_rules, '{}'::jsonb) || jsonb_build_object('conversation_sec', 60)
 where not (coalesce(analysis_rules, '{}'::jsonb) ? 'conversation_sec');

create or replace function conversation_sec() returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (analysis_rules->>'conversation_sec')::int from app_settings limit 1), 60)
$$;

-- new columns appended (create or replace view allows adding columns at the end)
create or replace view v_activity as
  select agent_id, contact_id, direction, 'call'::text as channel, occurred_at,
         (outcome in ('answered','connected') or duration_sec > 0) as connected, outcome,
         (outcome in ('answered','connected') and duration_sec >= conversation_sec()) as conversation
    from calls
  union all
  select agent_id, contact_id, direction, case when kind = 'voicemail' then 'voicemail' else 'text' end,
         occurred_at, null, null, null
    from messages;
revoke all on v_activity from anon, authenticated;

drop function if exists metrics_summary(date, date, uuid);
create function metrics_summary(p_from date, p_to date, p_agent uuid default null)
returns table (
  agent_id uuid, agent_name text, account_type text, gv_number text,
  outbound_total bigint, inbound_total bigint, contacts_reached bigint,
  outbound_calls bigint, connected_calls bigint, conversations bigint, outbound_texts bigint,
  inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint,
  response_rate numeric, avg_reply_min numeric, unclassified bigint,
  last_heartbeat_at timestamptz, tracking_start timestamptz
) language sql stable security definer set search_path = public as $$
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
      count(*) filter (where channel = 'call' and direction = 'inbound')                           as inbound_calls,
      count(*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) as missed_calls,
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
$$;

create or replace function ingest_batch(p_agent uuid, p_agent_number text, p_parser text, p_events jsonb, p_health jsonb,
                             p_client_start timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
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
          'inboundCalls',   count(*) filter (where channel = 'call' and direction = 'inbound'),
          'missedCalls',    count(*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
          'inboundTexts',   count(*) filter (where channel = 'text' and direction = 'inbound'),
          'voicemails',     count(*) filter (where channel = 'voicemail'))
          from v_activity v
         where v.agent_id = p_agent
           and v.occurred_at >= ((now() at time zone v_tz)::date - w.days + 1)::timestamp at time zone v_tz))
      from (values ('today', 1), ('7d', 7), ('30d', 30)) w(name, days)),
    'at', now());
end $$;

revoke execute on function ingest_batch(uuid, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
