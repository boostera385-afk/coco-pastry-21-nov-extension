-- Google Voice keeps every call in its own thread (c.*) and texts in t.* threads, so a contact shows up
-- many times in "conversations". These RPCs group everything per (agent, contact) for the dashboard,
-- and give a row-per-event activity log for detailed CSV reports.

create or replace function contact_threads(p_from date, p_to date, p_agent uuid default null, p_search text default null)
returns table (agent_id uuid, agent_name text, contact_id uuid, contact text, contact_name text,
               last_activity_at timestamptz, calls_out bigint, picked_up bigint, conversations bigint, no_answer bigint,
               calls_in bigint, missed bigint, texts_out bigint, texts_in bigint, voicemails bigint,
               talk_sec bigint, last_text text)
language sql stable security definer set search_path = public as $$
  with b as (select (p_from::timestamp at time zone biz_tz()) t0, ((p_to + 1)::timestamp at time zone biz_tz()) t1),
  ev as (
    select k.agent_id, k.contact_id, 'call'::text ch, k.direction, k.outcome, k.duration_sec, k.occurred_at, null::text body
      from calls k, b where k.occurred_at >= b.t0 and k.occurred_at < b.t1
    union all
    select m.agent_id, m.contact_id, case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, m.occurred_at, m.body
      from messages m, b where m.occurred_at >= b.t0 and m.occurred_at < b.t1
  )
  select ev.agent_id, a.name, ev.contact_id, ct.phone_e164, ct.name, max(ev.occurred_at),
    count(*) filter (where ch = 'call' and direction = 'outbound'),
    count(*) filter (where ch = 'call' and direction = 'outbound' and (outcome in ('answered','connected') or duration_sec > 0)),
    count(*) filter (where ch = 'call' and direction = 'outbound' and outcome in ('answered','connected') and duration_sec >= conversation_sec()),
    count(*) filter (where ch = 'call' and direction = 'outbound' and coalesce(duration_sec, 0) = 0),
    count(*) filter (where ch = 'call' and direction = 'inbound'),
    count(*) filter (where ch = 'call' and direction = 'inbound' and outcome in ('missed','voicemail')),
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
$$;

-- One row per call / text / voicemail. Agents get their own rows without message text; admins get everything.
create or replace function activity_log(p_from date, p_to date, p_agent uuid default null)
returns table (occurred_at timestamptz, local_time text, agent_name text, contact text, contact_name text,
               channel text, direction text, outcome text, duration_sec int, conversation boolean, body text)
language sql stable security definer set search_path = public as $$
  with b as (select (p_from::timestamp at time zone biz_tz()) t0, ((p_to + 1)::timestamp at time zone biz_tz()) t1, biz_tz() z),
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
$$;

-- Full history with one contact (calls + texts + voicemails), newest period first in the UI.
create or replace function contact_timeline(p_agent uuid, p_contact uuid)
returns table (kind text, direction text, outcome text, duration_sec int, conversation boolean, body text, occurred_at timestamptz)
language sql stable security definer set search_path = public as $$
  select 'call', k.direction,
         case when k.direction = 'outbound' then (case when k.duration_sec > 0 then 'connected' else 'no_answer' end) else k.outcome end,
         k.duration_sec, (k.outcome in ('answered','connected') and k.duration_sec >= conversation_sec()), null, k.occurred_at
    from calls k where is_manager() and k.agent_id = p_agent and k.contact_id is not distinct from p_contact
  union all
  select case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, null, m.body, m.occurred_at
    from messages m where is_manager() and m.agent_id = p_agent and m.contact_id is not distinct from p_contact
  order by occurred_at
$$;
