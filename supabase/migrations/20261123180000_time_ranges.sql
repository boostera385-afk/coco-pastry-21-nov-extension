-- Exact time ranges (e.g. "last 4 hours", "today 09:00-13:00"): every report function accepts optional
-- p_from_ts / p_to_ts. When given they override the whole-day range built from p_from / p_to (Pakistan time).
-- Plus metrics_timeline(): hourly or daily buckets for the trend chart.

drop function if exists public.analysis_issues(p_from date, p_to date, p_agent uuid, p_now timestamp with time zone) cascade;
CREATE FUNCTION public.analysis_issues(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_now timestamp with time zone DEFAULT now(), p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(issue_key text, rule text, severity text, agent_id uuid, agent_name text, contact_id uuid, contact text, conversation_id uuid, occurred_at timestamp with time zone, detail text, delay_min numeric, status text, note text, reviewed_by text, reviewed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r   jsonb := (select analysis_rules from app_settings where id = 1);
  t0  timestamptz := coalesce(p_from_ts, p_from::timestamp at time zone biz_tz());
  t1  timestamptz := coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz());
  reply_min int := coalesce((r->>'reply_target_min')::int, 15);
  cb_min    int := coalesce((r->>'callback_target_min')::int, 60);
  fu_h      int := coalesce((r->>'followup_after_hours')::int, 48);
  max_day   int := coalesce((r->>'max_unanswered_per_day')::int, 3);
  q_start   time := coalesce((r->>'quiet_start')::time, '21:00');
  q_end     time := coalesce((r->>'quiet_end')::time, '08:00');
  q_tz      text := coalesce(r->>'quiet_tz', 'America/New_York');
  short_s   int := coalesce((r->>'short_call_sec')::int, 15);
begin
  if not is_admin() then return; end if;

  return query
  with ev as (   -- all events (no date filter: replies may fall after the range)
    select 'c' || k.id::text as eid, k.agent_id, k.contact_id, k.conversation_id, k.direction,
           'call'::text as channel, k.outcome, k.duration_sec, k.occurred_at, null::text as body
      from calls k where p_agent is null or k.agent_id = p_agent
    union all
    select 'm' || m.id::text, m.agent_id, m.contact_id, m.conversation_id, m.direction,
           case when m.kind = 'voicemail' then 'voicemail' else 'text' end, null, 0, m.occurred_at, m.body
      from messages m where p_agent is null or m.agent_id = p_agent
  ),
  seq as (       -- per agent+contact timeline
    select ev.*, lag(ev.direction) over w as prev_dir, lag(ev.channel) over w as prev_channel,
           lag(ev.occurred_at) over w as prev_at
      from ev where ev.contact_id is not null
    window w as (partition by ev.agent_id, ev.contact_id order by ev.occurred_at)
  ),
  nxt as (       -- first outbound after each event, same agent + contact
    select s.*, (select min(o.occurred_at) from ev o
                  where o.agent_id = s.agent_id and o.contact_id = s.contact_id
                    and o.direction = 'outbound' and o.occurred_at > s.occurred_at) as next_out
      from seq s
  ),
  inr as (select * from nxt where nxt.occurred_at >= t0 and nxt.occurred_at < t1),
  issues as (
    -- R1 missed call / voicemail not returned (voicemail right after a missed call is the same event)
    select 'missed_call:' || i.eid as k, 'missed_call_not_returned' as rl,
           case when i.next_out is null then 'high' else 'medium' end as sev,
           i.agent_id, i.contact_id, i.conversation_id, i.occurred_at,
           case when i.next_out is null then 'Missed ' || case when i.channel = 'voicemail' then 'voicemail' else 'call' end || ' never returned'
                else 'Returned after ' || round(extract(epoch from i.next_out - i.occurred_at) / 60) || ' min (target ' || cb_min || ' min)' end as det,
           round((extract(epoch from coalesce(i.next_out, p_now) - i.occurred_at) / 60)::numeric, 1) as dly
      from inr i
     where i.direction = 'inbound'
       and ((i.channel = 'call' and i.outcome in ('missed', 'voicemail'))
            or (i.channel = 'voicemail' and (i.prev_channel = 'call' and i.prev_dir = 'inbound' and i.occurred_at - i.prev_at < interval '5 minutes') is not true))
       and coalesce(i.next_out, p_now) - i.occurred_at > make_interval(mins => cb_min)
    union all
    -- R2 customer text not answered in time (first text of a burst only)
    select 'reply:' || i.eid, 'text_not_answered',
           case when i.next_out is null then 'high' else 'medium' end,
           i.agent_id, i.contact_id, i.conversation_id, i.occurred_at,
           case when i.next_out is null then 'Customer text never answered: "' || left(coalesce(i.body, ''), 80) || '"'
                else 'Replied after ' || round(extract(epoch from i.next_out - i.occurred_at) / 60) || ' min (target ' || reply_min || ' min)' end,
           round((extract(epoch from coalesce(i.next_out, p_now) - i.occurred_at) / 60)::numeric, 1)
      from inr i
     where i.direction = 'inbound' and i.channel = 'text'
       and (i.prev_dir = 'inbound' and i.prev_channel = 'text') is not true   -- first text of a burst (also when it is the very first event)
       and coalesce(i.next_out, p_now) - i.occurred_at > make_interval(mins => reply_min)
    union all
    -- R3 contacted after opt-out
    select 'optout:' || o.eid, 'opt_out_ignored', 'high',
           o.agent_id, o.contact_id, o.conversation_id, o.occurred_at,
           'Contacted after the customer opted out ("' || left(st.body, 40) || '" at ' ||
             to_char(st.occurred_at at time zone biz_tz(), 'Mon DD HH24:MI') || ')', null::numeric
      from inr o
      join lateral (
        select s.body, s.occurred_at from ev s
         where s.agent_id = o.agent_id and s.contact_id = o.contact_id and s.direction = 'inbound' and s.channel = 'text'
           and s.occurred_at < o.occurred_at
           and (s.body ~* '^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt[ -]?out)\s*[.!]*\s*$'
                or s.body ~* '(do not|don''t|dont|never) (text|message|call|contact) me|remove me|take me off')
         order by s.occurred_at desc limit 1) st on true
     where o.direction = 'outbound'
    union all
    -- R4 over-contacting: > max outbound to one contact in a business day, no inbound that day
    select 'overcontact:' || d.agent_id || ':' || d.contact_id || ':' || d.day, 'over_contacting', 'medium',
           d.agent_id, d.contact_id, d.conversation_id, d.last_at,
           d.n || ' outbound to this contact on ' || to_char(d.day, 'Mon DD') || ' with no reply (limit ' || max_day || ')', null
      from (
        select i.agent_id, i.contact_id, max(i.conversation_id::text)::uuid as conversation_id,
               (i.occurred_at at time zone biz_tz())::date as day, max(i.occurred_at) as last_at,
               count(*) filter (where i.direction = 'outbound') as n,
               count(*) filter (where i.direction = 'inbound') as n_in
          from inr i group by 1, 2, 4
      ) d
     where d.n > max_day and d.n_in = 0
    union all
    -- R5 no follow-up: single unanswered attempt, older than followup_after_hours
    select 'followup:' || f.agent_id || ':' || f.contact_id, 'no_follow_up', 'low',
           f.agent_id, f.contact_id, f.conversation_id, f.first_out,
           'One attempt, no reply, no follow-up after ' || fu_h || ' h', null
      from (
        select e.agent_id, e.contact_id, max(e.conversation_id::text)::uuid as conversation_id,
               min(e.occurred_at) filter (where e.direction = 'outbound') as first_out,
               count(*) filter (where e.direction = 'outbound') as n_out,
               count(*) filter (where e.direction = 'inbound') as n_in
          from ev e where e.contact_id is not null group by 1, 2
      ) f
     where f.n_out = 1 and f.n_in = 0 and f.first_out >= t0 and f.first_out < t1
       and p_now - f.first_out > make_interval(hours => fu_h)
    union all
    -- R6 outbound during the customer's quiet hours
    select 'quiet:' || i.eid, 'quiet_hours', 'low',
           i.agent_id, i.contact_id, i.conversation_id, i.occurred_at,
           'Outbound ' || i.channel || ' at ' || to_char(i.occurred_at at time zone q_tz, 'HH24:MI') || ' customer time (quiet ' ||
             to_char(q_start, 'HH24:MI') || '–' || to_char(q_end, 'HH24:MI') || ')', null
      from inr i
     where i.direction = 'outbound'
       and case when q_start > q_end
                then (i.occurred_at at time zone q_tz)::time >= q_start or (i.occurred_at at time zone q_tz)::time < q_end
                else (i.occurred_at at time zone q_tz)::time >= q_start and (i.occurred_at at time zone q_tz)::time < q_end end
    union all
    -- R7 very short connected outbound call
    select 'shortcall:' || i.eid, 'very_short_call', 'low',
           i.agent_id, i.contact_id, i.conversation_id, i.occurred_at,
           'Connected call lasted only ' || i.duration_sec || ' s', null
      from inr i
     where i.direction = 'outbound' and i.channel = 'call' and i.duration_sec between 1 and short_s - 1
  )
  select x.k, x.rl, x.sev, x.agent_id, a.name, x.contact_id, c.phone_e164, x.conversation_id, x.occurred_at,
         x.det, x.dly, coalesce(rv.status, 'open'), rv.note, u.email::text, rv.reviewed_at
    from issues x
    join agents a on a.id = x.agent_id
    left join contacts c on c.id = x.contact_id
    left join analysis_reviews rv on rv.issue_key = x.k
    left join auth.users u on u.id = rv.reviewed_by
   order by case x.sev when 'high' then 0 when 'medium' then 1 else 2 end, x.occurred_at desc;
end $function$;

drop function if exists public.analysis_scorecard(p_from date, p_to date, p_agent uuid, p_now timestamp with time zone) cascade;
CREATE FUNCTION public.analysis_scorecard(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_now timestamp with time zone DEFAULT now(), p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_id uuid, agent_name text, score integer, high_open bigint, medium_open bigint, low_open bigint, issues_total bigint, reviewed bigint, dismissed bigint, customer_texts bigint, replied_on_time_pct numeric, median_reply_min numeric, missed_calls bigint, returned_on_time_pct numeric, opt_out_violations bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb := (select analysis_rules from app_settings where id = 1);
  t0 timestamptz := coalesce(p_from_ts, p_from::timestamp at time zone biz_tz());
  t1 timestamptz := coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz());
  reply_min int := coalesce((r->>'reply_target_min')::int, 15);
  cb_min    int := coalesce((r->>'callback_target_min')::int, 60);
begin
  if not is_admin() then return; end if;
  return query
  with iss as (select * from analysis_issues(p_from, p_to, p_agent, p_now, p_from_ts, p_to_ts)),
  ev as (
    select k.agent_id, k.contact_id, k.direction, 'call'::text as channel, k.outcome, k.occurred_at from calls k
     where p_agent is null or k.agent_id = p_agent
    union all
    select m.agent_id, m.contact_id, m.direction, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, null, m.occurred_at from messages m
     where p_agent is null or m.agent_id = p_agent
  ),
  seq as (
    select ev.*, lag(ev.direction) over w as prev_dir, lag(ev.channel) over w as prev_channel
      from ev where ev.contact_id is not null
    window w as (partition by ev.agent_id, ev.contact_id order by ev.occurred_at)
  ),
  firsts as (   -- first customer text of each burst / missed calls, with time to next outbound
    select s.agent_id, s.channel, s.outcome,
           extract(epoch from (select min(o.occurred_at) from ev o where o.agent_id = s.agent_id and o.contact_id = s.contact_id
                                 and o.direction = 'outbound' and o.occurred_at > s.occurred_at) - s.occurred_at) / 60 as mins
      from seq s
     where s.occurred_at >= t0 and s.occurred_at < t1 and s.direction = 'inbound'
       and ((s.channel = 'text' and (s.prev_dir = 'inbound' and s.prev_channel = 'text') is not true)
            or (s.channel = 'call' and s.outcome in ('missed', 'voicemail')))
  ),
  resp as (
    select f.agent_id,
           count(*) filter (where f.channel = 'text') as texts,
           round(100.0 * count(*) filter (where f.channel = 'text' and f.mins <= reply_min) / nullif(count(*) filter (where f.channel = 'text'), 0), 1) as on_time,
           round((percentile_cont(0.5) within group (order by f.mins) filter (where f.channel = 'text' and f.mins is not null))::numeric, 1) as med,
           count(*) filter (where f.channel = 'call') as missed,
           round(100.0 * count(*) filter (where f.channel = 'call' and f.mins <= cb_min) / nullif(count(*) filter (where f.channel = 'call'), 0), 1) as returned
      from firsts f group by 1
  ),
  agg as (
    select i.agent_id,
           count(*) filter (where i.severity = 'high' and i.status = 'open') as h,
           count(*) filter (where i.severity = 'medium' and i.status = 'open') as m,
           count(*) filter (where i.severity = 'low' and i.status = 'open') as l,
           count(*) as total,
           count(*) filter (where i.status = 'reviewed') as rv,
           count(*) filter (where i.status = 'dismissed') as ds,
           count(*) filter (where i.rule = 'opt_out_ignored') as optout,
           -- deductions: dismissed issues don't count; reviewed ones still count (they happened)
           sum(case when i.status = 'dismissed' then 0 when i.severity = 'high' then 8 when i.severity = 'medium' then 4 else 1 end) as ded
      from iss i group by 1
  )
  select a.id, a.name, greatest(0, 100 - coalesce(g.ded, 0))::int,
         coalesce(g.h, 0), coalesce(g.m, 0), coalesce(g.l, 0), coalesce(g.total, 0), coalesce(g.rv, 0), coalesce(g.ds, 0),
         coalesce(rs.texts, 0), rs.on_time, rs.med, coalesce(rs.missed, 0), rs.returned, coalesce(g.optout, 0)
    from agents a
    left join agg g on g.agent_id = a.id
    left join resp rs on rs.agent_id = a.id
   where (p_agent is null or a.id = p_agent) and a.active
   order by 3 asc, a.name;
end $function$;

drop function if exists public.metrics_summary(p_from date, p_to date, p_agent uuid) cascade;
CREATE FUNCTION public.metrics_summary(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_id uuid, agent_name text, account_type text, gv_number text, outbound_total bigint, inbound_total bigint, contacts_reached bigint, outbound_calls bigint, connected_calls bigint, conversations bigint, outbound_texts bigint, inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint, response_rate numeric, avg_reply_min numeric, unclassified bigint, last_heartbeat_at timestamp with time zone, tracking_start timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (
    select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) as t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) as t1
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
      count(*) filter (where (channel = 'call' and direction = 'inbound' and outcome = 'missed')) as missed_calls,
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

drop function if exists public.metrics_daily(p_from date, p_to date, p_agent uuid) cascade;
CREATE FUNCTION public.metrics_daily(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
       and v.occurred_at >= coalesce(p_from_ts, p_from::timestamp at time zone b.z)
       and v.occurred_at <  coalesce(p_to_ts, (p_to + 1)::timestamp at time zone b.z)
       and (p_agent is null or v.agent_id = p_agent)
  )
  select g.d::date,
    count(act.*) filter (where direction = 'outbound' and channel in ('call','text')),
    count(act.*) filter (where direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'outbound'),
    count(act.*) filter (where channel = 'text' and direction = 'outbound'),
    count(act.*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound'),
    count(act.*) filter (where (channel = 'call' and direction = 'inbound' and outcome = 'missed')),
    count(act.*) filter (where channel = 'text' and direction = 'inbound'),
    count(distinct act.contact_id) filter (where direction = 'outbound')
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
  left join act on act.d = g.d::date
  group by g.d order by g.d
$function$;

drop function if exists public.contact_activity(p_from date, p_to date, p_agent uuid, p_search text) cascade;
CREATE FUNCTION public.contact_activity(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(contact_id uuid, contact text, contact_name text, agent_id uuid, agent_name text, conversation_id uuid, calls_out bigint, connected bigint, texts_out bigint, calls_in bigint, missed bigint, texts_in bigint, voicemails bigint, total bigint, first_at timestamp with time zone, last_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) as t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) as t1),
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
         count(*) filter (where (channel = 'call' and direction = 'inbound' and outcome = 'missed')),
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

drop function if exists public.contact_threads(p_from date, p_to date, p_agent uuid, p_search text) cascade;
CREATE FUNCTION public.contact_threads(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_id uuid, agent_name text, contact_id uuid, contact text, contact_name text, last_activity_at timestamp with time zone, calls_out bigint, picked_up bigint, conversations bigint, no_answer bigint, calls_in bigint, missed bigint, texts_out bigint, texts_in bigint, voicemails bigint, talk_sec bigint, last_text text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1),
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
$function$;

drop function if exists public.activity_log(p_from date, p_to date, p_agent uuid) cascade;
CREATE FUNCTION public.activity_log(p_from date, p_to date, p_agent uuid DEFAULT NULL::uuid, p_from_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_ts timestamp with time zone DEFAULT NULL::timestamp with time zone)
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
           k.duration_sec, (k.outcome in ('answered','connected') and k.duration_sec >= conversation_sec()) conv, k.occurred_at, null::text body
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
$function$;


create or replace function metrics_timeline(p_from_ts timestamptz, p_to_ts timestamptz, p_agent uuid default null, p_bucket text default 'day')
returns table (bucket timestamp, outbound_total bigint, inbound_total bigint, outbound_calls bigint, outbound_texts bigint,
               inbound_calls bigint, missed_calls bigint, inbound_texts bigint, voicemails bigint)
language sql stable security definer set search_path = public as $$
  with b as (select biz_tz() z, case when p_bucket = 'hour' then 'hour' else 'day' end u),
  act as (
    select v.*, date_trunc(b.u, v.occurred_at at time zone b.z) as k
      from v_activity v, b
     where (is_admin() or v.agent_id = my_agent_id())
       and v.occurred_at >= p_from_ts and v.occurred_at < p_to_ts
       and (p_agent is null or v.agent_id = p_agent)
  ),
  g as (
    select generate_series(date_trunc(b.u, p_from_ts at time zone b.z), (p_to_ts at time zone b.z) - interval '1 second',
                           case when b.u = 'hour' then interval '1 hour' else interval '1 day' end) as k
      from b
  )
  select g.k,
    count(act.*) filter (where direction = 'outbound' and channel in ('call','text')),
    count(act.*) filter (where direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'outbound'),
    count(act.*) filter (where channel = 'text' and direction = 'outbound'),
    count(act.*) filter (where (channel = 'call' or (channel = 'voicemail' and vm_call)) and direction = 'inbound'),
    count(act.*) filter (where channel = 'call' and direction = 'inbound' and outcome = 'missed'),
    count(act.*) filter (where channel = 'text' and direction = 'inbound'),
    count(act.*) filter (where channel = 'voicemail')
  from g left join act on act.k = g.k
  group by g.k order by g.k
  limit 1000
$$;
