-- Vici click-to-dial (2026-11-28): the dashboard asks the agent's own browser extension to dial on the Vici agent
-- screen. Before dialing it checks this: a number any agent marked Do-Not-Call in Vici is never dialed from Coco.
create or replace function vici_dial_check(p_phone text)
returns table (dnc boolean, last_disposition text, last_call_at timestamptz, calls_today bigint)
language sql stable security definer set search_path = public as $$
  with d as (select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10) n),
  k as (select v.* from vici_calls v, d where length(d.n) = 10 and right(regexp_replace(coalesce(v.phone, ''), '\D', '', 'g'), 10) = d.n)
  select coalesce(bool_or(upper(k.disposition) in ('DNC', 'DNCL', 'DNCC')), false),
         (array_agg(k.disposition order by k.started_at desc) filter (where k.disposition is not null))[1],
         max(k.started_at),
         count(*) filter (where k.started_at >= ((now() at time zone biz_tz())::date)::timestamp at time zone biz_tz())
    from k
   where auth.uid() is not null and (is_admin() or my_agent_id() is not null)
$$;
revoke execute on function vici_dial_check(text) from public, anon;
grant execute on function vici_dial_check(text) to authenticated;
create index if not exists vici_calls_phone10 on vici_calls (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));
