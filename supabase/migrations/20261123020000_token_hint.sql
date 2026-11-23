-- Token hint (last 4 chars) so admins can tell tokens apart; the token itself is never stored.
alter table agents add column if not exists token_hint text;

create or replace function create_agent(p_name text, p_email text, p_account_type text default 'personal')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into agents (name, email, account_type, token_hash, token_hint)
  values (p_name, nullif(p_email, ''), p_account_type, encode(digest(v_token, 'sha256'), 'hex'), right(v_token, 4))
  returning id into v_id;
  return jsonb_build_object('agent_id', v_id, 'token', v_token);   -- shown once, never stored in plain text
end $$;

create or replace function rotate_agent_token(p_agent uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := 'coco_' || encode(gen_random_bytes(24), 'hex');
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update agents set token_hash = encode(digest(v_token, 'sha256'), 'hex'), token_hint = right(v_token, 4) where id = p_agent;
  return v_token;
end $$;
