-- Live dashboard: a cheap "has anything changed?" stamp the dashboard polls every few seconds.
-- Changes when a call / text / voicemail / recording / transcript / review lands or an extension checks in.
create index if not exists calls_created_at on calls (created_at);
create index if not exists messages_created_at on messages (created_at);

create or replace function activity_version()
returns text language sql stable security definer set search_path = public as $$
  select concat_ws('|',
    (select max(created_at) from calls    where is_admin() or agent_id = my_agent_id()),
    (select max(transcribed_at) from calls where is_admin()),
    (select max(created_at) from messages where is_admin() or agent_id = my_agent_id()),
    (select max(created_at) from call_recordings where is_admin()),
    (select max(reviewed_at) from analysis_reviews where is_admin()),
    (select count(*) from analysis_reviews where is_admin()),
    (select max(last_heartbeat_at) from agents where is_admin() or id = my_agent_id()))
$$;
revoke execute on function activity_version() from anon;
