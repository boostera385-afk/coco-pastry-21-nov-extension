-- Rule-based analysis (no AI): computed from calls/messages by SQL, reviewed by admins on the dashboard.
-- Every issue has a stable issue_key so an admin can mark it reviewed / dismissed with a note.

-- ---------- thresholds (admin-editable in Settings) ----------
alter table app_settings add column if not exists analysis_rules jsonb not null default jsonb_build_object(
  'reply_target_min', 15,          -- reply to a customer text within N minutes
  'callback_target_min', 60,       -- return a missed call / voicemail within N minutes
  'followup_after_hours', 48,      -- one unanswered attempt -> follow up after N hours
  'max_unanswered_per_day', 3,     -- more than N outbound to one contact in a day with no reply = over-contacting
  'quiet_start', '21:00',          -- no outbound between quiet_start and quiet_end ...
  'quiet_end', '08:00',
  'quiet_tz', 'America/New_York',  -- ... in the CUSTOMER's timezone (US Voice numbers)
  'short_call_sec', 15             -- connected outbound call shorter than this = very short call
);

-- ---------- admin reviews ----------
create table if not exists analysis_reviews (
  issue_key   text primary key,
  status      text not null check (status in ('reviewed', 'dismissed')),
  note        text,
  reviewed_by uuid references auth.users(id) on delete set null default auth.uid(),
  reviewed_at timestamptz not null default now()
);
alter table analysis_reviews enable row level security;
create policy rev_admin_all on analysis_reviews for all to authenticated using (is_admin()) with check (is_admin());

-- ---------- issues ----------
create or replace function analysis_issues(p_from date, p_to date, p_agent uuid default null, p_now timestamptz default now())
returns table (
  issue_key text, rule text, severity text, agent_id uuid, agent_name text,
  contact_id uuid, contact text, conversation_id uuid, occurred_at timestamptz,
  detail text, delay_min numeric, status text, note text, reviewed_by text, reviewed_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
declare
  r   jsonb := (select analysis_rules from app_settings where id = 1);
  t0  timestamptz := (p_from::timestamp at time zone biz_tz());
  t1  timestamptz := ((p_to + 1)::timestamp at time zone biz_tz());
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
end $$;

-- ---------- scorecard ----------
create or replace function analysis_scorecard(p_from date, p_to date, p_agent uuid default null, p_now timestamptz default now())
returns table (
  agent_id uuid, agent_name text, score int,
  high_open bigint, medium_open bigint, low_open bigint, issues_total bigint, reviewed bigint, dismissed bigint,
  customer_texts bigint, replied_on_time_pct numeric, median_reply_min numeric,
  missed_calls bigint, returned_on_time_pct numeric, opt_out_violations bigint
) language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb := (select analysis_rules from app_settings where id = 1);
  t0 timestamptz := (p_from::timestamp at time zone biz_tz());
  t1 timestamptz := ((p_to + 1)::timestamp at time zone biz_tz());
  reply_min int := coalesce((r->>'reply_target_min')::int, 15);
  cb_min    int := coalesce((r->>'callback_target_min')::int, 60);
begin
  if not is_admin() then return; end if;
  return query
  with iss as (select * from analysis_issues(p_from, p_to, p_agent, p_now)),
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
end $$;
