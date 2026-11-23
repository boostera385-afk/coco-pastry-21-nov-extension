-- Re-classification safety: when a newer parser changes an item's type (e.g. call -> text),
-- ingest moves it to the right table instead of leaving a stale row behind.
-- Also adds reparse support: ingest_batch is reused by scripts/reparse.mjs with corrected events.

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

revoke execute on function ingest_batch(uuid, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
