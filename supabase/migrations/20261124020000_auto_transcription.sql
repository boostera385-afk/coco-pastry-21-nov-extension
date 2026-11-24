-- Automatic transcription (2026-11-24)
-- Server first: the `transcribe` Edge Function sends audio to Groq (Whisper large-v3-turbo) right after a call.
-- Browser fallback: an admin's open dashboard transcribes jobs the server can't (no Groq key / Groq failed).
-- Coco's own recordings also upload one mono file per speaker (agent / caller) so every line gets the right label.

alter table call_recordings add column if not exists agent_path  text;
alter table call_recordings add column if not exists caller_path text;
alter table call_recordings add column if not exists transcript  text;
alter table call_recordings add column if not exists transcript_source text;
alter table calls add column if not exists transcript_job uuid;

alter table app_settings add column if not exists transcribe_language text not null default 'en';
alter table app_settings add column if not exists transcribe_prompt   text not null default 'Coco Voice, Pastry Marketing.';
alter table app_settings add column if not exists transcribe_status   jsonb;   -- written by the server: provider, last ok / error

create table if not exists transcription_jobs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('recording', 'voicemail', 'call')),  -- call = Google's own call recording
  ref_id      uuid not null,                     -- call_recordings.id | messages.id | calls.id
  agent_id    uuid references agents(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed', 'no_provider')),
  tries       int not null default 0,
  error       text,
  provider    text,
  claimed_at  timestamptz,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (kind, ref_id)
);
create index if not exists transcription_jobs_open on transcription_jobs (status, created_at) where status <> 'done';
alter table transcription_jobs enable row level security;
drop policy if exists "transcription_jobs: admins read" on transcription_jobs;
create policy "transcription_jobs: admins read" on transcription_jobs for select to authenticated using (is_admin());

-- Make sure every recording / voicemail / Google call recording without text has a job.
create or replace function enqueue_transcriptions()
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; k int;
begin
  insert into transcription_jobs (kind, ref_id, agent_id)
  select 'recording', r.id, r.agent_id from call_recordings r
   where r.transcript is null and r.created_at > now() - interval '30 days'
  on conflict (kind, ref_id) do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into transcription_jobs (kind, ref_id, agent_id)
  select 'voicemail', m.id, m.agent_id from messages m
   where m.kind = 'voicemail' and m.recording_path is not null and coalesce(m.body, '') = '' and m.occurred_at > now() - interval '30 days'
  on conflict (kind, ref_id) do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into transcription_jobs (kind, ref_id, agent_id)
  select 'call', c.id, c.agent_id from calls c
   where c.recording_path is not null and c.transcript is null and c.occurred_at > now() - interval '30 days'
     and not exists (select 1 from call_recordings r where r.call_id = c.id)
  on conflict (kind, ref_id) do nothing;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke execute on function enqueue_transcriptions() from public, anon, authenticated;

-- Claim jobs with a lease (10 min) so two workers never do the same one.
-- mode 'server': pending or retryable jobs. mode 'browser': jobs the server can't do (no provider / gave up / stuck).
-- A recording waits up to 10 min for its per-speaker files (older extensions don't send them -> mixed file is used).
create or replace function claim_transcriptions(p_mode text default 'server', p_limit int default 3)
returns table (job_id uuid, kind text, ref_id uuid, audio_path text, agent_path text, caller_path text, duration_sec int)
language plpgsql security definer set search_path = public as $$
begin
  if p_mode = 'browser' and not is_admin() then raise exception 'admins only'; end if;
  if p_mode = 'server' and coalesce(auth.role(), '') <> 'service_role' then raise exception 'server only'; end if;
  return query
  with pick as (
    select j.id from transcription_jobs j
      left join call_recordings r on j.kind = 'recording' and r.id = j.ref_id
     where (case when p_mode = 'server'
                 then (j.status = 'pending' or (j.status = 'failed' and j.tries < 4 and j.claimed_at < now() - make_interval(mins => 2 * j.tries)))
                 else (j.status in ('no_provider') or (j.status = 'failed' and j.tries >= 4) or (j.status = 'pending' and j.created_at < now() - interval '15 minutes')) end
            or (j.status = 'working' and j.claimed_at < now() - interval '10 minutes'))
       and (j.kind <> 'recording' or (r.agent_path is not null and r.caller_path is not null) or r.created_at < now() - interval '10 minutes')
     order by j.created_at
     limit greatest(1, least(p_limit, 10))
     for update of j skip locked
  ), upd as (
    update transcription_jobs j set status = 'working', claimed_at = now(), tries = j.tries + 1
      from pick where j.id = pick.id returning j.*
  )
  select u.id, u.kind, u.ref_id,
         coalesce(r.path, m.recording_path, c.recording_path), r.agent_path, r.caller_path,
         coalesce(r.duration_sec, c.duration_sec)
    from upd u
    left join call_recordings r on u.kind = 'recording' and r.id = u.ref_id
    left join messages m on u.kind = 'voicemail' and m.id = u.ref_id
    left join calls c on u.kind = 'call' and c.id = u.ref_id;
end $$;
revoke execute on function claim_transcriptions(text, int) from public, anon;

-- Save a finished transcript wherever it belongs (and onto the matched call for Coco recordings).
create or replace function complete_transcription(p_job uuid, p_text text, p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare j transcription_jobs; t text := nullif(trim(coalesce(p_text, '')), '');
begin
  if not (is_admin() or coalesce(auth.role(), '') = 'service_role') then raise exception 'not allowed'; end if;
  select * into j from transcription_jobs where id = p_job;
  if not found then return; end if;
  t := coalesce(t, '(no speech detected)');
  if j.kind = 'recording' then
    update call_recordings set transcript = t, transcript_source = p_provider where id = j.ref_id;
    update calls c set transcript = t, transcript_source = p_provider, transcribed_at = now()
      from call_recordings r where r.id = j.ref_id and c.id = r.call_id
       and (c.transcript is null or c.transcript_source in ('whisper', 'whisper-browser', 'groq') or c.transcript = '(no speech detected)');
  elsif j.kind = 'voicemail' then
    update messages set body = t, transcript_source = p_provider where id = j.ref_id and kind = 'voicemail';
  else
    update calls set transcript = t, transcript_source = p_provider, transcribed_at = now() where id = j.ref_id;
  end if;
  update transcription_jobs set status = 'done', done_at = now(), provider = p_provider, error = null where id = p_job;
end $$;
revoke execute on function complete_transcription(uuid, text, text) from public, anon;

create or replace function fail_transcription(p_job uuid, p_error text, p_no_provider boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or coalesce(auth.role(), '') = 'service_role') then raise exception 'not allowed'; end if;
  update transcription_jobs set status = case when p_no_provider then 'no_provider' else 'failed' end,
         error = left(p_error, 300) where id = p_job;
end $$;
revoke execute on function fail_transcription(uuid, text, boolean) from public, anon;

-- Admin: do it again with the best available model.
create or replace function retranscribe(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare k text := p_kind; rid uuid := p_id;
begin
  if not is_admin() then raise exception 'admins only'; end if;
  if p_kind = 'call' then  -- a call with Coco's own recording: redo the recording job
    select r.id into rid from call_recordings r where r.call_id = p_id limit 1;
    if rid is not null then k := 'recording'; else rid := p_id; end if;
  end if;
  insert into transcription_jobs (kind, ref_id, agent_id) values (k, rid, null)
  on conflict (kind, ref_id) do update set status = 'pending', tries = 0, error = null, claimed_at = null, done_at = null;
end $$;
revoke execute on function retranscribe(text, uuid) from public, anon;

-- Dashboard status card.
create or replace function transcription_overview()
returns table (pending bigint, working bigint, failed bigint, no_provider bigint, done_24h bigint, last_done_at timestamptz, last_error text, server jsonb)
language sql stable security definer set search_path = public as $$
  select count(*) filter (where status = 'pending'), count(*) filter (where status = 'working'),
         count(*) filter (where status = 'failed'), count(*) filter (where status = 'no_provider'),
         count(*) filter (where status = 'done' and done_at > now() - interval '24 hours'),
         max(done_at), (array_agg(error order by claimed_at desc) filter (where error is not null))[1],
         (select transcribe_status from app_settings where id = 1)
    from transcription_jobs where is_admin()
$$;

-- When a recording gets linked to its call later, copy its transcript over too.
create or replace function match_call_recordings(p_agent uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; v uuid; n int := 0;
begin
  for r in select * from call_recordings
            where agent_id = p_agent and call_id is null and started_at > now() - interval '7 days'
            order by started_at loop
    select k.id into v from calls k
     where k.agent_id = p_agent
       and k.occurred_at between r.started_at - interval '3 minutes' and r.started_at + interval '1 minute'
       and not exists (select 1 from call_recordings x where x.call_id = k.id)
     order by abs(extract(epoch from k.occurred_at - r.started_at)) limit 1;
    if v is not null then
      update call_recordings set call_id = v where id = r.id;
      update calls set recording_path = coalesce(recording_path, r.path),
                       transcript = coalesce(transcript, r.transcript),
                       transcript_source = case when transcript is null then r.transcript_source else transcript_source end
       where id = v;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function match_call_recordings(uuid) from public, anon, authenticated;

-- Existing browser-made transcripts (small model) get redone with the best model.
insert into transcription_jobs (kind, ref_id, agent_id)
select 'recording', r.id, r.agent_id from call_recordings r on conflict do nothing;
update transcription_jobs j set status = 'pending', tries = 0 where j.kind = 'recording';
insert into transcription_jobs (kind, ref_id, agent_id)
select 'voicemail', m.id, m.agent_id from messages m where m.kind = 'voicemail' and m.transcript_source = 'whisper'
on conflict (kind, ref_id) do update set status = 'pending', tries = 0;
select enqueue_transcriptions();
