-- New agents default to Google Workspace Voice (Personal is still allowed). Existing agents are unchanged.
alter table agents alter column account_type set default 'workspace';

create or replace function create_agent(p_name text, p_email text, p_account_type text default 'workspace')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not is_manager() then raise exception 'admins and managers only'; end if;
  insert into agents (name, email, account_type, token_hash, token_hint)
  values (p_name, nullif(p_email, ''), coalesce(nullif(p_account_type, ''), 'workspace'),
          encode(digest(v_token, 'sha256'), 'hex'), right(v_token, 4))
  returning id into v_id;
  return jsonb_build_object('agent_id', v_id, 'token', v_token);
end $$;
