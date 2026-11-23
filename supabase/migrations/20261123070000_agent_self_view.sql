-- Agents keep seeing THEIR OWN numbers on the dashboard (as before). Admins see everything.
-- Manager role is retired: is_manager() stays admin-only, so transcripts, contacts and conversations
-- remain admin-only. Agent users are linked to their tracking agent via profiles.agent_id.

create or replace function my_agent_id() returns uuid language sql stable security definer set search_path = public as $$
  select agent_id from profiles where user_id = auth.uid() and role = 'agent'
$$;

create or replace function metrics_summary(p_from date, p_to date, p_agent uuid default null)
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

create or replace function metrics_daily(p_from date, p_to date, p_agent uuid default null)
returns table (day date, outbound_total bigint, inbound_total bigint, outbound_calls bigint, outbound_texts bigint,
               inbound_calls bigint, missed_calls bigint, inbound_texts bigint, contacts_reached bigint)
language sql stable security definer set search_path = public as $$
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
    count(act.*) filter (where channel = 'call' and direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
    count(act.*) filter (where channel = 'text' and direction = 'inbound'),
    count(distinct act.contact_id) filter (where direction = 'outbound')
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
  left join act on act.d = g.d::date
  group by g.d order by g.d
$$;
