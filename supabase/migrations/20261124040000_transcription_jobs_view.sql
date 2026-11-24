-- Dashboard list of transcription jobs + browser retry cap.
create or replace function transcription_jobs_list(p_limit int default 100)
returns table (job_id uuid, kind text, ref_id uuid, status text, tries int, error text, provider text, created_at timestamptz, done_at timestamptz,
               occurred_at timestamptz, duration_sec int, agent_name text, contact text, agent_id uuid, contact_id uuid)
language sql stable security definer set search_path = public as $$
  select j.id, j.kind, j.ref_id, j.status, j.tries, j.error, j.provider, j.created_at, j.done_at,
         coalesce(c.occurred_at, r.started_at, m.occurred_at, c2.occurred_at), coalesce(r.duration_sec, c2.duration_sec),
         a.name, ct.phone_e164, a.id, coalesce(c.contact_id, m.contact_id, c2.contact_id)
    from transcription_jobs j
    left join call_recordings r on j.kind = 'recording' and r.id = j.ref_id
    left join calls c on c.id = r.call_id
    left join messages m on j.kind = 'voicemail' and m.id = j.ref_id
    left join calls c2 on j.kind = 'call' and c2.id = j.ref_id
    left join agents a on a.id = coalesce(j.agent_id, r.agent_id, m.agent_id, c2.agent_id)
    left join contacts ct on ct.id = coalesce(c.contact_id, m.contact_id, c2.contact_id)
   where is_admin()
   order by (j.status = 'done'), j.created_at desc
   limit greatest(1, least(p_limit, 500))
$$;

-- browser fallback stops after 8 attempts (a broken file must not loop forever)
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
     where ((case when p_mode = 'server'
                 then (j.status = 'pending' or (j.status = 'failed' and j.tries < 4 and j.claimed_at < now() - make_interval(mins => 2 * j.tries)))
                 else (j.status = 'no_provider' or (j.status = 'failed' and j.tries >= 4) or (j.status = 'pending' and j.created_at < now() - interval '15 minutes')) end)
            or (j.status = 'working' and j.claimed_at < now() - interval '10 minutes'))
       and (p_mode = 'server' or j.tries < 8)
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
