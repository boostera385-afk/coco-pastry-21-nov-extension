-- Vici Dialer gets the same analysis tools as Google Voice, still kept apart from the Google Voice numbers:
--   * trend (per hour / day) and busiest-times heatmap for Vici calls
--   * transcript search also finds Vici call transcripts
--   * Analysis checks for Vici calls (very short call, over-dialing a number, calling a DNC number, manual dials in
--     quiet hours) -> they show on the Analysis page and count in the agent scorecard like Google Voice issues.

-- ---------- trend ----------
create or replace function public.vici_timeline(p_from_ts timestamptz, p_to_ts timestamptz, p_agent uuid default null, p_bucket text default 'day')
returns table(bucket timestamp, calls bigint, connected bigint, conversations bigint, manual bigint, auto bigint, inbound bigint, talk_sec bigint)
language sql stable security definer set search_path to 'public' as $$
  with b as (select biz_tz() z, case when p_bucket = 'hour' then 'hour' else 'day' end u),
  act as (
    select v.*, date_trunc(b.u, v.started_at at time zone b.z) as k
      from vici_calls v, b
     where (is_admin() or v.agent_id = my_agent_id())
       and v.started_at >= p_from_ts and v.started_at < p_to_ts
       and (p_agent is null or v.agent_id = p_agent)
  ),
  g as (
    select generate_series(date_trunc(b.u, p_from_ts at time zone b.z), (p_to_ts at time zone b.z) - interval '1 second',
                           case when b.u = 'hour' then interval '1 hour' else interval '1 day' end) as k
      from b
  )
  select g.k,
    count(act.id),
    count(act.id) filter (where act.talk_sec > 0),
    count(act.id) filter (where is_conversation(case when act.talk_sec > 0 then 'answered' end, act.talk_sec, act.answered_by)),
    count(act.id) filter (where act.dial_type = 'manual'),
    count(act.id) filter (where act.dial_type = 'auto'),
    count(act.id) filter (where act.dial_type = 'inbound' or act.direction = 'inbound'),
    coalesce(sum(act.talk_sec), 0)::bigint
  from g left join act on act.k = g.k
  group by g.k order by g.k
  limit 1000
$$;

-- ---------- busiest times ----------
create or replace function public.vici_heatmap(p_from date, p_to date, p_agent uuid default null, p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table(dow int, hour int, calls bigint, connected bigint, conversations bigint)
language sql stable security definer set search_path to 'public' as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1),
  act as (
    select v.*, extract(isodow from v.started_at at time zone biz_tz())::int d, extract(hour from v.started_at at time zone biz_tz())::int h
      from vici_calls v, b
     where v.started_at >= b.t0 and v.started_at < b.t1
       and (is_admin() or v.agent_id = my_agent_id()) and (p_agent is null or v.agent_id = p_agent)
  )
  select d, h, count(*),
         count(*) filter (where talk_sec > 0),
         count(*) filter (where is_conversation(case when talk_sec > 0 then 'answered' end, talk_sec, answered_by))
    from act group by d, h order by d, h
$$;

-- ---------- transcript search: Google Voice + Vici ----------
create or replace function public.search_transcripts(p_q text, p_from date, p_to date, p_agent uuid default null, p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table(kind text, id uuid, agent_id uuid, agent_name text, contact_id uuid, contact text, occurred_at timestamptz, snippet text)
language sql stable security definer set search_path to 'public' as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1)
  select * from (
    select 'call'::text, k.id, k.agent_id, a.name, k.contact_id, c.phone_e164, k.occurred_at, left(k.transcript, 300)
      from calls k join agents a on a.id = k.agent_id left join contacts c on c.id = k.contact_id, b
     where k.transcript ilike '%' || p_q || '%' and k.occurred_at >= b.t0 and k.occurred_at < b.t1
    union all
    select 'voicemail', m.id, m.agent_id, a.name, m.contact_id, c.phone_e164, m.occurred_at, left(m.body, 300)
      from messages m join agents a on a.id = m.agent_id left join contacts c on c.id = m.contact_id, b
     where m.kind = 'voicemail' and m.body ilike '%' || p_q || '%' and m.occurred_at >= b.t0 and m.occurred_at < b.t1
    union all
    select 'vici', v.id, v.agent_id, a.name, null::uuid, coalesce(v.phone, v.contact_name), v.started_at, left(v.transcript, 300)
      from vici_calls v join agents a on a.id = v.agent_id, b
     where v.transcript ilike '%' || p_q || '%' and v.started_at >= b.t0 and v.started_at < b.t1
  ) q
  where is_admin() and length(trim(coalesce(p_q, ''))) >= 2 and (p_agent is null or q.agent_id = p_agent)
  order by occurred_at desc limit 200
$$;

-- ---------- Analysis: Vici checks ----------
-- Same settings as the Google Voice checks (Settings -> analysis rules). Vici numbers have no contact row, so the
-- number is returned in `contact`; issue keys start with "vici-" so reviews never collide with Google Voice issues.
create or replace function public.vici_issues(p_from date, p_to date, p_agent uuid default null, p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table(issue_key text, rule text, severity text, agent_id uuid, contact text, occurred_at timestamptz, detail text)
language plpgsql stable security definer set search_path to 'public' as $$
declare
  r       jsonb := (select analysis_rules from app_settings where id = 1);
  t0      timestamptz := coalesce(p_from_ts, p_from::timestamp at time zone biz_tz());
  t1      timestamptz := coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz());
  max_day int  := coalesce((r->>'max_unanswered_per_day')::int, 3);
  q_start time := coalesce((r->>'quiet_start')::time, '21:00');
  q_end   time := coalesce((r->>'quiet_end')::time, '08:00');
  q_tz    text := coalesce(r->>'quiet_tz', 'America/New_York');
  short_s int  := coalesce((r->>'short_call_sec')::int, 15);
begin
  if not is_admin() then return; end if;
  return query
  with v as (
    select x.*, right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10) as p10
      from vici_calls x
     where x.started_at >= t0 and x.started_at < t1 and (p_agent is null or x.agent_id = p_agent)
  )
  -- very short connected call (not a voicemail / phone menu)
  select 'vici-short:' || v.id, 'very_short_call', 'low', v.agent_id, v.phone, v.started_at,
         'Vici call connected only ' || v.talk_sec || ' s' || coalesce(' (' || v.disposition || ')', '')
    from v
   where v.talk_sec between 1 and short_s - 1 and v.answered_by is distinct from 'voicemail'
  union all
  -- calling a number that was already marked Do Not Call in Vici (any agent)
  select 'vici-dnc:' || v.id, 'opt_out_ignored', 'high', v.agent_id, v.phone, v.started_at,
         'Vici call to a number marked ' || d.disposition || ' on ' || to_char(d.started_at at time zone biz_tz(), 'Mon DD HH24:MI')
    from v
    join lateral (
      select o.disposition, o.started_at from vici_calls o
       where right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 10) = v.p10
         and upper(o.disposition) in ('DNC', 'DNCL', 'DNCC') and o.started_at < v.started_at
       order by o.started_at desc limit 1) d on true
   where length(v.p10) = 10 and v.dial_type is distinct from 'inbound' and v.direction is distinct from 'inbound'
  union all
  -- one number dialed manually too often in a day without a conversation
  select 'vici-over:' || g.agent_id || ':' || g.p10 || ':' || g.day, 'over_contacting', 'medium', g.agent_id, g.phone, g.last_at,
         'Vici: ' || g.n || ' manual dials to this number on ' || to_char(g.day, 'Mon DD') || ' without a conversation (limit ' || max_day || ')'
    from (
      select v.agent_id, v.p10, max(v.phone) as phone, (v.started_at at time zone biz_tz())::date as day, max(v.started_at) as last_at,
             count(*) as n,
             count(*) filter (where is_conversation(case when v.talk_sec > 0 then 'answered' end, v.talk_sec, v.answered_by)) as conv
        from v where v.dial_type = 'manual' and length(v.p10) = 10 group by 1, 2, 4
    ) g
   where g.n > max_day and g.conv = 0
  union all
  -- manual dial in the customer's quiet hours (auto dials follow the campaign's own call times)
  select 'vici-quiet:' || v.id, 'quiet_hours', 'low', v.agent_id, v.phone, v.started_at,
         'Vici manual dial at ' || to_char(v.started_at at time zone q_tz, 'HH24:MI') || ' customer time (quiet ' ||
           to_char(q_start, 'HH24:MI') || '–' || to_char(q_end, 'HH24:MI') || ')'
    from v
   where v.dial_type = 'manual'
     and case when q_start > q_end
              then (v.started_at at time zone q_tz)::time >= q_start or (v.started_at at time zone q_tz)::time < q_end
              else (v.started_at at time zone q_tz)::time >= q_start and (v.started_at at time zone q_tz)::time < q_end end;
end $$;

-- analysis_issues = Google Voice checks (unchanged, renamed) + Vici checks; the scorecard and Overview use it as before.
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'analysis_issues_gv' and pronamespace = 'public'::regnamespace) then
    alter function public.analysis_issues(date, date, uuid, timestamptz, timestamptz, timestamptz) rename to analysis_issues_gv;
  end if;
end $$;

create or replace function public.analysis_issues(p_from date, p_to date, p_agent uuid default null, p_now timestamptz default now(), p_from_ts timestamptz default null, p_to_ts timestamptz default null)
returns table(issue_key text, rule text, severity text, agent_id uuid, agent_name text, contact_id uuid, contact text, conversation_id uuid, occurred_at timestamptz, detail text, delay_min numeric, status text, note text, reviewed_by text, reviewed_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select * from (
    select * from analysis_issues_gv(p_from, p_to, p_agent, p_now, p_from_ts, p_to_ts)
    union all
    select x.issue_key, x.rule, x.severity, x.agent_id, a.name, null::uuid, x.contact, null::uuid, x.occurred_at, x.detail, null::numeric,
           coalesce(rv.status, 'open'), rv.note, u.email::text, rv.reviewed_at
      from vici_issues(p_from, p_to, p_agent, p_from_ts, p_to_ts) x
      join agents a on a.id = x.agent_id
      left join analysis_reviews rv on rv.issue_key = x.issue_key
      left join auth.users u on u.id = rv.reviewed_by
  ) q
  order by case q.severity when 'high' then 0 when 'medium' then 1 else 2 end, q.occurred_at desc
$$;

revoke execute on function public.analysis_issues_gv(date, date, uuid, timestamptz, timestamptz, timestamptz) from public, anon;
revoke execute on function public.vici_issues(date, date, uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.vici_timeline(timestamptz, timestamptz, uuid, text) from anon;
revoke execute on function public.vici_heatmap(date, date, uuid, timestamptz, timestamptz) from anon;
grant execute on function public.vici_timeline(timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.vici_heatmap(date, date, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.analysis_issues(date, date, uuid, timestamptz, timestamptz, timestamptz) to authenticated;
