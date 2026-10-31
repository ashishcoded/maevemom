-- Server-only RPCs for profile PIN hashes.
-- The private schema remains unexposed; browser roles cannot execute these functions.

create function public.get_profile_pin_hashes(
  p_user_id uuid,
  p_profile_ids uuid[]
)
returns table(profile_id uuid, pin_hash text)
language sql
security definer
set search_path = pg_catalog
as $$
  select secrets.profile_id, secrets.pin_hash
    from private.profile_secrets as secrets
    join public.profiles as profiles
      on profiles.id = secrets.profile_id
     and profiles.user_id = p_user_id
   where p_user_id is not null
     and p_profile_ids is not null
     and secrets.profile_id = any(p_profile_ids);
$$;

create function public.upsert_profile_pin_hash(
  p_user_id uuid,
  p_profile_id uuid,
  p_pin_hash text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_user_id is null or p_profile_id is null or p_pin_hash is null then
    raise exception using errcode = '22004', message = 'Profile PIN RPC arguments cannot be null';
  end if;

  if not exists (
    select 1
      from public.profiles
     where profiles.id = p_profile_id
       and profiles.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'Profile ownership check failed';
  end if;

  insert into private.profile_secrets(profile_id, pin_hash, updated_at)
  values (p_profile_id, p_pin_hash, now())
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash,
        updated_at = excluded.updated_at;
end;
$$;

create function public.delete_profile_pin_hash(
  p_user_id uuid,
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_user_id is null or p_profile_id is null then
    raise exception using errcode = '22004', message = 'Profile PIN RPC arguments cannot be null';
  end if;

  if not exists (
    select 1
      from public.profiles
     where profiles.id = p_profile_id
       and profiles.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'Profile ownership check failed';
  end if;

  delete from private.profile_secrets
   where profile_id = p_profile_id;
end;
$$;

revoke all on function public.get_profile_pin_hashes(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.upsert_profile_pin_hash(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_profile_pin_hash(uuid, uuid) from public, anon, authenticated;

grant execute on function public.get_profile_pin_hashes(uuid, uuid[]) to service_role;
grant execute on function public.upsert_profile_pin_hash(uuid, uuid, text) to service_role;
grant execute on function public.delete_profile_pin_hash(uuid, uuid) to service_role;
