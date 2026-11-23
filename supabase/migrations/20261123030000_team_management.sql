-- Team management: managers (not only admins) can manage agents and their tracking tokens,
-- and both can list dashboard users. Creating/removing login users happens in the `team` Edge Function.

create or replace function create_agent(p_name text, p_email text, p_account_type text default 'personal')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not is_manager() then raise exception 'admins and managers only'; end if;
  insert into agents (name, email, account_type, token_hash, token_hint)
  values (p_name, nullif(p_email, ''), p_account_type, encode(digest(v_token, 'sha256'), 'hex'), right(v_token, 4))
  returning id into v_id;
  return jsonb_build_object('agent_id', v_id, 'token', v_token);
end $$;

create or replace function rotate_agent_token(p_agent uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex');
begin
  if not is_manager() then raise exception 'admins and managers only'; end if;
  update agents set token_hash = encode(digest(v_token, 'sha256'), 'hex'), token_hint = right(v_token, 4) where id = p_agent;
  return v_token;
end $$;

create or replace function update_agent(p_agent uuid, p_name text, p_account_type text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_manager() then raise exception 'admins and managers only'; end if;
  update agents set name = p_name, account_type = p_account_type, active = p_active where id = p_agent;
end $$;

drop function if exists list_users();
create function list_users()
returns table (user_id uuid, email text, name text, role text, agent_id uuid,
               created_at timestamptz, last_sign_in_at timestamptz, must_change_password boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, u.raw_user_meta_data->>'name', p.role, p.agent_id,
         u.created_at, u.last_sign_in_at, coalesce((u.raw_user_meta_data->>'must_change_password')::boolean, false)
    from profiles p join auth.users u on u.id = p.user_id
   where is_manager()
   order by p.role, u.email
$$;
