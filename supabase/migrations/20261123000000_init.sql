-- Coco — Google Voice activity tracker. Supabase schema v0.2 (2026-11-23)
-- Decisions baked in:
--   * personal Google Voice AND Google Workspace Voice (agents.account_type), any number of agents
--   * outbound reach = unique contact once per agent per business day
--   * tracking starts at 00:00 (business TZ) of the day the extension first syncs; older events are dropped
--   * only managers/admins can read transcripts (messages, conversations, analysis)
--   * business timezone (US) and Claude analysis schedule are admin settings

create extension if not exists pgcrypto with schema extensions;

-- ======================================================================
-- Settings (single row)
-- ======================================================================
create table app_settings (
  id                    smallint primary key default 1 check (id = 1),
  business_timezone     text not null default 'America/New_York' check (business_timezone in (
                          'America/New_York','America/Chicago','America/Denver','America/Phoenix',
                          'America/Los_Angeles','America/Anchorage','Pacific/Honolulu')),
  analysis_mode         text not null default 'daily' check (analysis_mode in ('manual','hourly','daily','weekly')),
  analysis_time         time not null default '19:00',      -- local business time (daily / weekly)
  analysis_weekday      smallint not null default 5 check (analysis_weekday between 0 and 6), -- 0=Sun (weekly + coaching)
  analysis_model        text not null default 'claude-sonnet-5-5',
  coaching_model        text not null default 'claude-opus-5-5',
  retention_days        integer not null default 365 check (retention_days >= 30),
  last_analysis_run_at  timestamptz,
  updated_at            timestamptz not null default now()
);
insert into app_settings default values;

create function biz_tz() returns text language sql stable security definer set search_path = public as $$
  select business_timezone from app_settings where id = 1
$$;

-- ======================================================================
-- People
-- ======================================================================
create table agents (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  email             text unique,
  gv_number         text,                                   -- E.164, auto-detected by the extension
  account_type      text not null default 'personal' check (account_type in ('personal','workspace')),
  token_hash        text unique not null,                   -- sha256(hex) of the ingest token
  tracking_start    timestamptz,                            -- set on first sync (start of that business day)
  active            boolean not null default true,
  last_heartbeat_at timestamptz,
  last_health       jsonb,
  parser_version    text,
  created_at        timestamptz not null default now()
);

create table profiles (                                     -- dashboard users
  user_id  uuid primary key references auth.users(id) on delete cascade,
  role     text not null check (role in ('admin','manager','agent')),
  agent_id uuid references agents(id) on delete set null
);

create table contacts (
  id            uuid primary key default gen_random_uuid(),
  phone_e164    text unique not null,
  name          text,
  first_seen_at timestamptz not null default now()
);

-- ======================================================================
-- Capture
-- ======================================================================
create table raw_events (
  id             bigint generated always as identity primary key,
  agent_id       uuid not null references agents(id) on delete cascade,
  gv_id          text,
  event_type     text not null,
  parser_version text,
  payload        jsonb not null,
  received_at    timestamptz not null default now()
);
create index on raw_events (agent_id, received_at);

create table conversations (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references agents(id) on delete cascade,
  contact_id       uuid references contacts(id),
  gv_thread_id     text not null,
  last_activity_at timestamptz,
  last_analyzed_at timestamptz,
  created_at       timestamptz not null default now(),
  unique (agent_id, gv_thread_id)
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references agents(id) on delete cascade,
  gv_id           text not null,
  conversation_id uuid not null references conversations(id) on delete cascade,
  contact_id      uuid references contacts(id),
  direction       text not null check (direction in ('inbound','outbound')),
  kind            text not null default 'sms' check (kind in ('sms','voicemail')),
  body            text,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (agent_id, gv_id)
);
create index on messages (agent_id, occurred_at);
create index on messages (conversation_id, occurred_at);

create table calls (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references agents(id) on delete cascade,
  gv_id           text not null,
  conversation_id uuid references conversations(id) on delete set null,
  contact_id      uuid references contacts(id),
  direction       text not null check (direction in ('inbound','outbound')),
  outcome         text check (outcome in ('answered','missed','voicemail','rejected','unknown')),
  duration_sec    integer not null default 0,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (agent_id, gv_id)
);
create index on calls (agent_id, occurred_at);

-- Events the parser could not classify (until FIELD_MAP is verified). Kept for re-parsing.
create table unclassified_events (
  id          bigint generated always as identity primary key,
  agent_id    uuid not null references agents(id) on delete cascade,
  gv_id       text not null,
  type_code   jsonb,
  occurred_at timestamptz not null,
  payload     jsonb not null,
  unique (agent_id, gv_id)
);

-- ======================================================================
-- Claude analysis (written by the analysis worker with the service role)
-- ======================================================================
create table conversation_analysis (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  agent_id         uuid not null references agents(id) on delete cascade,
  model            text not null,
  analyzed_through timestamptz not null,
  overall_score    smallint check (overall_score between 1 and 10),
  outcome          text,             -- booked | interested | follow_up | not_interested | no_reply | opted_out
  sentiment        text,             -- positive | neutral | negative
  summary          text,
  scores           jsonb not null default '{}',   -- per rubric point, 1-5
  mistakes         jsonb not null default '[]',   -- [{message_id, rule, issue, severity, suggestion}]
  improvements     jsonb not null default '[]',   -- [string]
  created_at       timestamptz not null default now()
);
create index on conversation_analysis (agent_id, created_at);
create index on conversation_analysis (conversation_id, created_at desc);

create table agent_coaching_reports (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  model        text not null,
  report       jsonb not null,       -- {summary, strengths[], top_mistakes[], action_items[], example_conversation_ids[]}
  created_at   timestamptz not null default now(),
  unique (agent_id, period_start, period_end)
);

create table analysis_requests (     -- "Run analysis now" button
  id              bigint generated always as identity primary key,
  requested_by    uuid references auth.users(id) default auth.uid(),
  agent_id        uuid references agents(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending','running','done','error')),
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- ======================================================================
-- Roles
-- ======================================================================
create function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin')
$$;
create function is_manager() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role in ('admin','manager'))
$$;
create function my_agent_id() returns uuid language sql stable security definer set search_path = public as $$
  select agent_id from profiles where user_id = auth.uid()
$$;

-- ======================================================================
-- RLS — transcripts are manager-only; agents see only their own call log & coaching
-- ======================================================================
alter table app_settings           enable row level security;
alter table agents                 enable row level security;
alter table profiles               enable row level security;
alter table contacts               enable row level security;
alter table raw_events             enable row level security;
alter table conversations          enable row level security;
alter table messages               enable row level security;
alter table calls                  enable row level security;
alter table unclassified_events    enable row level security;
alter table conversation_analysis  enable row level security;
alter table agent_coaching_reports enable row level security;
alter table analysis_requests      enable row level security;

create policy settings_read   on app_settings for select to authenticated using (true);
create policy settings_update on app_settings for update to authenticated using (is_admin()) with check (is_admin());

create policy agents_read  on agents   for select to authenticated using (is_manager() or id = my_agent_id());
create policy profile_read on profiles for select to authenticated using (user_id = auth.uid() or is_manager());
create policy contact_read on contacts for select to authenticated using (is_manager());

create policy conv_read  on conversations         for select to authenticated using (is_manager());
create policy msg_read   on messages              for select to authenticated using (is_manager());
create policy anal_read  on conversation_analysis for select to authenticated using (is_manager());
create policy call_read  on calls                 for select to authenticated using (is_manager() or agent_id = my_agent_id());
create policy coach_read on agent_coaching_reports for select to authenticated using (is_manager() or agent_id = my_agent_id());
create policy uncl_read  on unclassified_events   for select to authenticated using (is_manager());
create policy req_read   on analysis_requests     for select to authenticated using (is_manager());
create policy req_insert on analysis_requests     for insert to authenticated with check (is_manager());
-- raw_events: no policy -> service role only. All other writes go through security-definer RPCs.

-- ======================================================================
-- Ingest (called by the /ingest Edge Function with the service role)
-- ======================================================================
create function ingest_batch(p_agent uuid, p_agent_number text, p_parser text, p_events jsonb, p_health jsonb,
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
    -- install day 00:00 local, as reported by the extension (accepted if within the last 7 days)
    v_start := case when p_client_start between now() - interval '7 days' and now() then p_client_start
                    else date_trunc('day', now() at time zone v_tz) at time zone v_tz end;
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

  insert into unclassified_events (agent_id, gv_id, type_code, occurred_at, payload)
  select p_agent, gv_id, type_code, occurred_at, payload from _ev
   where kind not in ('text','voicemail','call') or kind is null or direction not in ('inbound','outbound') or direction is null
  on conflict (agent_id, gv_id) do update set payload = excluded.payload, type_code = excluded.type_code;

  return jsonb_build_object(
    'accepted', v_ok, 'skipped_before_tracking_start', v_total - v_ok,
    'config', jsonb_build_object('timezone', v_tz, 'tracking_start', v_start));
end $$;
revoke execute on function ingest_batch(uuid, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;

-- ======================================================================
-- Metrics (security definer; scope enforced inside)
-- ======================================================================
create view v_activity as
  select agent_id, contact_id, direction, 'call'::text as channel, occurred_at,
         (outcome = 'answered' or duration_sec > 0) as connected, outcome
    from calls
  union all
  select agent_id, contact_id, direction, case when kind = 'voicemail' then 'voicemail' else 'text' end,
         occurred_at, null, null
    from messages;
revoke all on v_activity from anon, authenticated;

create function metrics_summary(p_from date, p_to date, p_agent uuid default null)
returns table (
  agent_id uuid, agent_name text, account_type text, gv_number text,
  outbound_reaches bigint, outbound_calls bigint, connected_calls bigint, outbound_texts bigint,
  inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint, inbound_contacts bigint,
  response_rate numeric, avg_reply_min numeric, unclassified bigint, avg_score numeric,
  analyzed_conversations bigint, last_heartbeat_at timestamptz, tracking_start timestamptz
) language sql stable security definer set search_path = public as $$
  with b as (
    select (p_from::timestamp at time zone biz_tz()) as t0,
           ((p_to + 1)::timestamp at time zone biz_tz()) as t1, biz_tz() as z
  ),
  scope as (
    select a.* from agents a
     where (p_agent is null or a.id = p_agent) and (is_manager() or a.id = my_agent_id())
  ),
  act as (
    select v.*, (v.occurred_at at time zone b.z)::date as day
      from v_activity v, b
     where v.occurred_at >= b.t0 and v.occurred_at < b.t1 and v.agent_id in (select id from scope)
  ),
  counts as (
    select act.agent_id,
      count(distinct act.contact_id::text || act.day) filter (where direction = 'outbound' and contact_id is not null) as outbound_reaches,
      count(*) filter (where channel = 'call' and direction = 'outbound')                        as outbound_calls,
      count(*) filter (where channel = 'call' and direction = 'outbound' and connected)          as connected_calls,
      count(*) filter (where channel = 'text' and direction = 'outbound')                        as outbound_texts,
      count(*) filter (where channel = 'call' and direction = 'inbound')                         as inbound_calls,
      count(*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')) as missed_calls,
      count(*) filter (where channel = 'text' and direction = 'inbound')                         as inbound_texts,
      count(*) filter (where channel = 'voicemail')                                              as voicemails,
      count(distinct act.contact_id::text || act.day) filter (where direction = 'inbound' and contact_id is not null) as inbound_contacts
    from act group by act.agent_id
  ),
  first_out as (
    select act.agent_id, act.contact_id, min(act.occurred_at) as t
      from act where direction = 'outbound' and contact_id is not null group by 1, 2
  ),
  resp as (   -- % of contacts reached who replied (text/call) within 7 days
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
     where i.direction = 'inbound' and i.channel in ('text','call','voicemail') and nx.t is not null
     group by 1
  ),
  unc as (
    select u.agent_id, count(*) as n from unclassified_events u, b
     where u.occurred_at >= b.t0 and u.occurred_at < b.t1 group by 1
  ),
  sc as (
    select ca.agent_id, round(avg(ca.overall_score), 1) as s, count(distinct ca.conversation_id) as n
      from conversation_analysis ca, b where ca.created_at >= b.t0 and ca.created_at < b.t1 group by 1
  )
  select s.id, s.name, s.account_type, s.gv_number,
         coalesce(c.outbound_reaches, 0), coalesce(c.outbound_calls, 0), coalesce(c.connected_calls, 0),
         coalesce(c.outbound_texts, 0), coalesce(c.inbound_calls, 0), coalesce(c.missed_calls, 0),
         coalesce(c.inbound_texts, 0), coalesce(c.voicemails, 0), coalesce(c.inbound_contacts, 0),
         r.response_rate, rp.avg_reply_min, coalesce(u.n, 0),
         case when is_manager() then sc.s end, case when is_manager() then coalesce(sc.n, 0) end,
         s.last_heartbeat_at, s.tracking_start
    from scope s
    left join counts c on c.agent_id = s.id
    left join resp r   on r.agent_id = s.id
    left join reply rp on rp.agent_id = s.id
    left join unc u    on u.agent_id = s.id
    left join sc       on sc.agent_id = s.id
   order by coalesce(c.outbound_reaches, 0) desc, s.name
$$;

create function metrics_daily(p_from date, p_to date, p_agent uuid default null)
returns table (day date, outbound_reaches bigint, outbound_calls bigint, outbound_texts bigint,
               inbound_calls bigint, missed_calls bigint, inbound_texts bigint)
language sql stable security definer set search_path = public as $$
  with b as (select biz_tz() as z),
  act as (
    select v.*, (v.occurred_at at time zone b.z)::date as d
      from v_activity v, b
     where v.occurred_at >= (p_from::timestamp at time zone b.z)
       and v.occurred_at <  ((p_to + 1)::timestamp at time zone b.z)
       and (p_agent is null or v.agent_id = p_agent)
       and (is_manager() or v.agent_id = my_agent_id())
  )
  select g.d::date,
    count(distinct act.agent_id::text || act.contact_id::text) filter (where direction = 'outbound' and contact_id is not null),
    count(*) filter (where channel = 'call' and direction = 'outbound'),
    count(*) filter (where channel = 'text' and direction = 'outbound'),
    count(*) filter (where channel = 'call' and direction = 'inbound'),
    count(*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
    count(*) filter (where channel = 'text' and direction = 'inbound')
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
  left join act on act.d = g.d::date
  group by g.d order by g.d
$$;

-- Manager-only conversation list (transcripts)
create function conversation_list(p_from date, p_to date, p_agent uuid default null, p_search text default null)
returns table (id uuid, agent_id uuid, agent_name text, contact text, contact_name text, last_activity_at timestamptz,
               messages bigint, calls bigint, last_text text, score smallint, outcome text, analyzed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select cv.id, cv.agent_id, a.name, ct.phone_e164, ct.name, cv.last_activity_at,
         (select count(*) from messages m where m.conversation_id = cv.id),
         (select count(*) from calls k where k.conversation_id = cv.id),
         (select m.body from messages m where m.conversation_id = cv.id order by m.occurred_at desc limit 1),
         an.overall_score, an.outcome, an.created_at
    from conversations cv
    join agents a on a.id = cv.agent_id
    left join contacts ct on ct.id = cv.contact_id
    left join lateral (select * from conversation_analysis x where x.conversation_id = cv.id
                        order by x.created_at desc limit 1) an on true
   where is_manager()
     and cv.last_activity_at >= (p_from::timestamp at time zone biz_tz())
     and cv.last_activity_at <  ((p_to + 1)::timestamp at time zone biz_tz())
     and (p_agent is null or cv.agent_id = p_agent)
     and (p_search is null or ct.phone_e164 ilike '%' || p_search || '%' or ct.name ilike '%' || p_search || '%'
          or exists (select 1 from messages m where m.conversation_id = cv.id and m.body ilike '%' || p_search || '%'))
   order by cv.last_activity_at desc
   limit 200
$$;

-- ======================================================================
-- Admin RPCs
-- ======================================================================
create function create_agent(p_name text, p_email text, p_account_type text default 'personal')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into agents (name, email, account_type, token_hash)
  values (p_name, nullif(p_email, ''), p_account_type, encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;
  return jsonb_build_object('agent_id', v_id, 'token', v_token);   -- shown once, never stored in plain text
end $$;

create function rotate_agent_token(p_agent uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex');
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update agents set token_hash = encode(digest(v_token, 'sha256'), 'hex') where id = p_agent;
  return v_token;
end $$;

create function update_agent(p_agent uuid, p_name text, p_account_type text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update agents set name = p_name, account_type = p_account_type, active = p_active where id = p_agent;
end $$;

-- Give a signed-up dashboard user a role (user must have logged in once).
create function set_user_role(p_email text, p_role text, p_agent uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then raise exception 'No user with that email has signed in yet'; end if;
  insert into profiles (user_id, role, agent_id) values (v_uid, p_role, p_agent)
  on conflict (user_id) do update set role = excluded.role, agent_id = excluded.agent_id;
end $$;

create function list_users() returns table (email text, role text, agent_id uuid)
language sql stable security definer set search_path = public as $$
  select u.email::text, p.role, p.agent_id from profiles p join auth.users u on u.id = p.user_id where is_admin()
$$;

-- ======================================================================
-- Analysis scheduling helper for the Claude worker (see docs/03)
-- ======================================================================
create function analysis_due(p_now timestamptz default now()) returns boolean
language sql stable security definer set search_path = public as $$
  with s as (select *, (p_now at time zone business_timezone) as lnow from app_settings where id = 1),
  slot as (
    select s.*, case analysis_mode
      when 'hourly' then date_trunc('hour', lnow)
      when 'daily'  then date_trunc('day', lnow) + analysis_time
                         - case when lnow::time < analysis_time then interval '1 day' else interval '0' end
      when 'weekly' then date_trunc('day', lnow) + analysis_time
                         - make_interval(days => ((extract(dow from lnow)::int - analysis_weekday + 7) % 7))
                         - case when extract(dow from lnow)::int = analysis_weekday and lnow::time < analysis_time
                                then interval '7 days' else interval '0' end
      end as last_slot_local
    from s
  )
  select case when analysis_mode = 'manual' then false
              else coalesce(last_analysis_run_at < (last_slot_local at time zone business_timezone), true) end
     or exists (select 1 from analysis_requests where status = 'pending')
    from slot
$$;
revoke execute on function analysis_due(timestamptz) from public, anon, authenticated;

-- First admin: after you log in once, run in the SQL editor:
--   insert into profiles (user_id, role) select id, 'admin' from auth.users where email = 'you@company.com';
