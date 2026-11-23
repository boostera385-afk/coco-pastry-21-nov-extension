-- Department rules (2026-11-23):
-- 1 Google Voice business (Workspace) accounts only
-- 2 count every call and every text, reported per contact
-- 3 tracking starts at the moment the agent connects; no old history
-- 4 only admins can use the dashboard (manager/agent dashboard access removed)
-- 5/7 Claude analysis on hold (manual only; tables kept for later)
-- 6 business timezone = Pakistan (Asia/Karachi)

-- 6 timezone
alter table app_settings drop constraint if exists app_settings_business_timezone_check;
alter table app_settings add constraint app_settings_business_timezone_check check (business_timezone in (
  'Asia/Karachi','America/New_York','America/Chicago','America/Denver','America/Phoenix',
  'America/Los_Angeles','America/Anchorage','Pacific/Honolulu'));
alter table app_settings alter column business_timezone set default 'Asia/Karachi';
-- 5/7 Claude on hold
alter table app_settings alter column analysis_mode set default 'manual';
update app_settings set business_timezone = 'Asia/Karachi', analysis_mode = 'manual', updated_at = now() where id = 1;

-- 1 business accounts only
update agents set account_type = 'workspace' where account_type <> 'workspace';
alter table agents drop constraint if exists agents_account_type_check;
alter table agents add constraint agents_account_type_check check (account_type = 'workspace');
alter table agents alter column account_type set default 'workspace';

-- 4 admins only: every policy / RPC that used is_manager() or my_agent_id() now means "admin".
create or replace function is_manager() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin')
$$;
create or replace function my_agent_id() returns uuid language sql stable security definer set search_path = public as $$
  select null::uuid   -- agents have no dashboard access; they only use the extension token
$$;

create or replace function create_agent(p_name text, p_email text, p_account_type text default 'workspace')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into agents (name, email, account_type, token_hash, token_hint)
  values (p_name, nullif(p_email, ''), 'workspace', encode(digest(v_token, 'sha256'), 'hex'), right(v_token, 4))
  returning id into v_id;
  return jsonb_build_object('agent_id', v_id, 'token', v_token);
end $$;

-- 3 tracking start = connect moment
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
         case when ev.outcome in ('answered','missed','voicemail','rejected') then ev.outcome
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

  return jsonb_build_object(
    'accepted', v_ok, 'skipped_before_tracking_start', v_total - v_ok,
    'config', jsonb_build_object('timezone', v_tz, 'tracking_start', v_start));
end $$;

-- 2 every call and every text; contacts reached = distinct contacts in the range
drop function if exists metrics_summary(date, date, uuid);
create function metrics_summary(p_from date, p_to date, p_agent uuid default null)
returns table (
  agent_id uuid, agent_name text, account_type text, gv_number text,
  outbound_total bigint, inbound_total bigint, contacts_reached bigint,
  outbound_calls bigint, connected_calls bigint, outbound_texts bigint,
  inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint,
  response_rate numeric, avg_reply_min numeric, unclassified bigint,
  last_heartbeat_at timestamptz, tracking_start timestamptz
) language sql stable security definer set search_path = public as $$
  with b as (
    select (p_from::timestamp at time zone biz_tz()) as t0, ((p_to + 1)::timestamp at time zone biz_tz()) as t1
  ),
  scope as (select a.* from agents a where is_admin() and (p_agent is null or a.id = p_agent)),
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
         coalesce(c.outbound_calls, 0), coalesce(c.connected_calls, 0), coalesce(c.outbound_texts, 0),
         coalesce(c.inbound_calls, 0), coalesce(c.missed_calls, 0), coalesce(c.inbound_texts, 0), coalesce(c.voicemails, 0),
         r.response_rate, rp.avg_reply_min, coalesce(u.n, 0), s.last_heartbeat_at, s.tracking_start
    from scope s
    left join counts c on c.agent_id = s.id
    left join resp r   on r.agent_id = s.id
    left join reply rp on rp.agent_id = s.id
    left join unc u    on u.agent_id = s.id
   order by coalesce(c.outbound_total, 0) desc, s.name
$$;

drop function if exists metrics_daily(date, date, uuid);
create function metrics_daily(p_from date, p_to date, p_agent uuid default null)
returns table (day date, outbound_total bigint, inbound_total bigint, outbound_calls bigint, outbound_texts bigint,
               inbound_calls bigint, missed_calls bigint, inbound_texts bigint, contacts_reached bigint)
language sql stable security definer set search_path = public as $$
  with b as (select biz_tz() as z),
  act as (
    select v.*, (v.occurred_at at time zone b.z)::date as d
      from v_activity v, b
     where is_admin()
       and v.occurred_at >= (p_from::timestamp at time zone b.z)
       and v.occurred_at <  ((p_to + 1)::timestamp at time zone b.z)
       and (p_agent is null or v.agent_id = p_agent)
  )
  select g.d::date,
    count(act.*) filter (where direction = 'outbound' and channel in ('call','text')),
    count(act.*) filter (where direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'outbound'),
    count(act.*) filter (where channel = 'text' and direction = 'outbound'),
    count(act.*) filter (where channel = 'call' and direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
    count(act.*) filter (where channel = 'text' and direction = 'inbound'),
    count(distinct act.contact_id) filter (where direction = 'outbound')
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
  left join act on act.d = g.d::date
  group by g.d order by g.d
$$;

-- 2 "under contact": every call and text per contact
create or replace function contact_activity(p_from date, p_to date, p_agent uuid default null, p_search text default null)
returns table (contact_id uuid, contact text, contact_name text, agent_id uuid, agent_name text, conversation_id uuid,
               calls_out bigint, connected bigint, texts_out bigint, calls_in bigint, missed bigint, texts_in bigint,
               voicemails bigint, total bigint, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public as $$
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
         count(*) filter (where channel = 'call' and direction = 'inbound'),
         count(*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
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
$$;
