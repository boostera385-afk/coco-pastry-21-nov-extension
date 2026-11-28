-- Vici status names (as the agent screen shows them, e.g. N = "No Answer") for the Vici calls list,
-- and remove stored diagnostic samples recorded before the extension redacted every password-like field (orig_pass).
update agents set vici_health = vici_health - 'samples' where vici_health ? 'samples';

drop function if exists public.vici_calls_list(date, date, uuid, timestamptz, timestamptz, text, int);
create function public.vici_calls_list(p_from date, p_to date, p_agent uuid default null, p_from_ts timestamptz default null,
  p_to_ts timestamptz default null, p_search text default null, p_limit int default 300)
returns table(id uuid, agent_id uuid, agent_name text, started_at timestamptz, ended_at timestamptz, phone text, contact_name text, lead_id text,
  campaign text, direction text, dial_type text, disposition text, disposition_name text, talk_sec int, conversation boolean, answered_by text,
  recording_path text, transcript text, transcript_source text, vici_user text)
language sql stable security definer set search_path to 'public' as $$
  with b as (select coalesce(p_from_ts, p_from::timestamp at time zone biz_tz()) t0, coalesce(p_to_ts, (p_to + 1)::timestamp at time zone biz_tz()) t1)
  select v.id, v.agent_id, a.name, v.started_at, v.ended_at, v.phone, v.contact_name, v.lead_id, v.campaign, v.direction, v.dial_type,
         v.disposition, nullif(left(v.payload->>'disposition_name', 60), ''), v.talk_sec,
         is_conversation(case when v.talk_sec > 0 then 'answered' end, v.talk_sec, v.answered_by), v.answered_by,
         case when is_admin() then v.recording_path end, case when is_admin() then v.transcript end, v.transcript_source, v.vici_user
    from vici_calls v cross join b join agents a on a.id = v.agent_id
   where v.started_at >= b.t0 and v.started_at < b.t1
     and (is_admin() or v.agent_id = my_agent_id()) and (p_agent is null or v.agent_id = p_agent)
     and (p_search is null or v.phone ilike '%' || p_search || '%' or v.contact_name ilike '%' || p_search || '%'
          or v.disposition ilike p_search or v.payload->>'disposition_name' ilike '%' || p_search || '%'
          or (is_admin() and v.transcript ilike '%' || p_search || '%'))
   order by v.started_at desc
   limit greatest(1, least(coalesce(p_limit, 300), 2000))
$$;
revoke execute on function public.vici_calls_list(date, date, uuid, timestamptz, timestamptz, text, int) from public, anon;
grant execute on function public.vici_calls_list(date, date, uuid, timestamptz, timestamptz, text, int) to authenticated;
