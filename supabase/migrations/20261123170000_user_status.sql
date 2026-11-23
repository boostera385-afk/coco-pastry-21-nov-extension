-- Users list shows whether a login is suspended (Supabase ban) and the agent's active flag.
drop function if exists list_users();
create function list_users()
returns table (user_id uuid, email text, name text, role text, agent_id uuid,
               created_at timestamptz, last_sign_in_at timestamptz, must_change_password boolean, suspended boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, u.raw_user_meta_data->>'name', p.role, p.agent_id,
         u.created_at, u.last_sign_in_at, coalesce((u.raw_user_meta_data->>'must_change_password')::boolean, false),
         coalesce(u.banned_until > now(), false)
    from profiles p join auth.users u on u.id = p.user_id
   where is_manager()
   order by p.role, u.email
$$;
