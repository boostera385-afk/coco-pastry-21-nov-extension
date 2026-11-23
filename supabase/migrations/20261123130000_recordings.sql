-- Voicemail audio (and Google Voice call recordings, when the Workspace admin enables recording)
-- are copied by the extension into a PRIVATE storage bucket. Only admins can play them.

alter table messages add column if not exists recording_path text;
alter table calls    add column if not exists recording_path text;
alter table calls    add column if not exists transcript text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 26214400,
        array['audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/amr','application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "recordings: admins read" on storage.objects;
create policy "recordings: admins read" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and public.is_manager());
-- uploads happen only through the ingest Edge Function (service role); no client writes.

drop function if exists contact_timeline(uuid, uuid);
create function contact_timeline(p_agent uuid, p_contact uuid)
returns table (kind text, direction text, outcome text, duration_sec int, conversation boolean, body text,
               occurred_at timestamptz, recording_path text)
language sql stable security definer set search_path = public as $$
  select 'call', k.direction,
         case when k.direction = 'outbound' then (case when k.duration_sec > 0 then 'connected' else 'no_answer' end) else k.outcome end,
         k.duration_sec, (k.outcome in ('answered','connected') and k.duration_sec >= conversation_sec()), k.transcript, k.occurred_at, k.recording_path
    from calls k where is_manager() and k.agent_id = p_agent and k.contact_id is not distinct from p_contact
  union all
  select case when m.kind = 'voicemail' then 'voicemail' else 'text' end, m.direction, null, null, null, m.body, m.occurred_at, m.recording_path
    from messages m where is_manager() and m.agent_id = p_agent and m.contact_id is not distinct from p_contact
  order by occurred_at
$$;

-- Called by the ingest function after it stored the audio file.
create or replace function attach_recording(p_agent uuid, p_gv_id text, p_path text)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; k int;
begin
  update messages set recording_path = p_path where agent_id = p_agent and gv_id = p_gv_id;
  get diagnostics k = row_count; n := n + k;
  update calls set recording_path = p_path where agent_id = p_agent and gv_id = p_gv_id;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke execute on function attach_recording(uuid, text, text) from public, anon, authenticated;
