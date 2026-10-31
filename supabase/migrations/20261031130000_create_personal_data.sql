-- Maeve'mom personal data schema only.
-- Deliberately excludes rooms, room members, chat, shared media, and realtime state.
-- No legacy JSON data is seeded or migrated by this migration.

create schema if not exists private;

create table public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null,
  avatar text,
  avatar_color text,
  bio text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  avatar_key text,
  avatar_emoji text,
  avatar_color text,
  avatar_bucket text not null default 'profile-assets',
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table private.profile_secrets (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash text,
  updated_at timestamptz not null default now()
);

create table public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.memories (
  id uuid primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  text text,
  color text not null default '#f5a58c',
  made_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.memory_assets (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null,
  user_id uuid not null references public.app_users(id) on delete cascade,
  kind text not null check (kind in ('image', 'audio')),
  storage_bucket text not null default 'memory-assets',
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  created_at timestamptz not null default now(),
  unique (memory_id, kind),
  foreign key (memory_id, user_id)
    references public.memories(id, user_id) on delete cascade
);

create table public.alert_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  phone_number text not null,
  recipient_user_id uuid references public.app_users(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (user_id, phone_number)
);

create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_users(id) on delete cascade,
  storage_bucket text not null default 'media-assets',
  storage_path text not null,
  compatible_storage_path text,
  original_name text not null,
  mime_type text,
  byte_size bigint not null check (byte_size >= 0),
  display_order integer not null default 0 check (display_order >= 0),
  uploaded_at timestamptz not null default now(),
  compatibility_status text not null default 'idle'
    check (compatibility_status in ('idle', 'queued', 'processing', 'ready', 'failed', 'unavailable'))
);

create table public.user_preferences (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  templates jsonb not null default '[]'::jsonb,
  enabled_emojis jsonb,
  chat_text_style jsonb,
  lobby_muted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists mm_personal_data_20261031130000_profiles_user_id_idx on public.profiles(user_id);
create index if not exists mm_personal_data_20261031130000_device_sessions_user_id_idx on public.device_sessions(user_id);
create index if not exists mm_personal_data_20261031130000_device_sessions_active_idx on public.device_sessions(user_id, revoked_at, last_active_at desc);
create index if not exists mm_personal_data_20261031130000_memories_user_id_made_at_idx on public.memories(user_id, made_at);
create index if not exists mm_personal_data_20261031130000_memory_assets_user_id_idx on public.memory_assets(user_id);
create index if not exists mm_personal_data_20261031130000_alert_contacts_user_id_idx on public.alert_contacts(user_id);
create index if not exists mm_personal_data_20261031130000_media_items_owner_order_idx on public.media_items(owner_id, display_order, uploaded_at);

create or replace function public.mm_personal_data_20261031130000_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists mm_personal_data_20261031130000_app_users_updated_at on public.app_users;
create trigger mm_personal_data_20261031130000_app_users_updated_at
before update on public.app_users
for each row execute function public.mm_personal_data_20261031130000_set_updated_at();

drop trigger if exists mm_personal_data_20261031130000_profiles_updated_at on public.profiles;
create trigger mm_personal_data_20261031130000_profiles_updated_at
before update on public.profiles
for each row execute function public.mm_personal_data_20261031130000_set_updated_at();

drop trigger if exists mm_personal_data_20261031130000_memories_updated_at on public.memories;
create trigger mm_personal_data_20261031130000_memories_updated_at
before update on public.memories
for each row execute function public.mm_personal_data_20261031130000_set_updated_at();

drop trigger if exists mm_personal_data_20261031130000_user_preferences_updated_at on public.user_preferences;
create trigger mm_personal_data_20261031130000_user_preferences_updated_at
before update on public.user_preferences
for each row execute function public.mm_personal_data_20261031130000_set_updated_at();

create or replace function public.mm_personal_data_20261031130000_validate_session_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.profile_id is not null and not exists (
    select 1 from public.profiles
    where profiles.id = new.profile_id
      and profiles.user_id = new.user_id
  ) then
    raise exception 'device session profile does not belong to the session user';
  end if;
  return new;
end;
$$;

drop trigger if exists mm_personal_data_20261031130000_device_session_profile on public.device_sessions;
create trigger mm_personal_data_20261031130000_device_session_profile
before insert or update of user_id, profile_id on public.device_sessions
for each row execute function public.mm_personal_data_20261031130000_validate_session_profile();

alter table public.app_users enable row level security;
alter table public.profiles enable row level security;
alter table public.device_sessions enable row level security;
alter table public.memories enable row level security;
alter table public.memory_assets enable row level security;
alter table public.alert_contacts enable row level security;
alter table public.media_items enable row level security;
alter table public.user_preferences enable row level security;
alter table private.profile_secrets enable row level security;

drop policy if exists mm_personal_data_20261031130000_app_users_select_own on public.app_users;
create policy mm_personal_data_20261031130000_app_users_select_own on public.app_users
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_app_users_insert_own on public.app_users;
create policy mm_personal_data_20261031130000_app_users_insert_own on public.app_users
  for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_app_users_update_own on public.app_users;
create policy mm_personal_data_20261031130000_app_users_update_own on public.app_users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_profiles_select_own on public.profiles;
create policy mm_personal_data_20261031130000_profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_profiles_insert_own on public.profiles;
create policy mm_personal_data_20261031130000_profiles_insert_own on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_profiles_update_own on public.profiles;
create policy mm_personal_data_20261031130000_profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_profiles_delete_own on public.profiles;
create policy mm_personal_data_20261031130000_profiles_delete_own on public.profiles
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_device_sessions_select_own on public.device_sessions;
create policy mm_personal_data_20261031130000_device_sessions_select_own on public.device_sessions
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_device_sessions_insert_own on public.device_sessions;
create policy mm_personal_data_20261031130000_device_sessions_insert_own on public.device_sessions
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and (profile_id is null or exists (
      select 1 from public.profiles
      where profiles.id = device_sessions.profile_id
        and profiles.user_id = (select auth.uid())
    ))
  );
drop policy if exists mm_personal_data_20261031130000_device_sessions_update_own on public.device_sessions;
create policy mm_personal_data_20261031130000_device_sessions_update_own on public.device_sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (profile_id is null or exists (
      select 1 from public.profiles
      where profiles.id = device_sessions.profile_id
        and profiles.user_id = (select auth.uid())
    ))
  );
drop policy if exists mm_personal_data_20261031130000_device_sessions_delete_own on public.device_sessions;
create policy mm_personal_data_20261031130000_device_sessions_delete_own on public.device_sessions
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_memories_select_own on public.memories;
create policy mm_personal_data_20261031130000_memories_select_own on public.memories
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memories_insert_own on public.memories;
create policy mm_personal_data_20261031130000_memories_insert_own on public.memories
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memories_update_own on public.memories;
create policy mm_personal_data_20261031130000_memories_update_own on public.memories
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memories_delete_own on public.memories;
create policy mm_personal_data_20261031130000_memories_delete_own on public.memories
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_memory_assets_select_own on public.memory_assets;
create policy mm_personal_data_20261031130000_memory_assets_select_own on public.memory_assets
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memory_assets_insert_own on public.memory_assets;
create policy mm_personal_data_20261031130000_memory_assets_insert_own on public.memory_assets
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memory_assets_update_own on public.memory_assets;
create policy mm_personal_data_20261031130000_memory_assets_update_own on public.memory_assets
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_memory_assets_delete_own on public.memory_assets;
create policy mm_personal_data_20261031130000_memory_assets_delete_own on public.memory_assets
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_alert_contacts_select_own on public.alert_contacts;
create policy mm_personal_data_20261031130000_alert_contacts_select_own on public.alert_contacts
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_alert_contacts_insert_own on public.alert_contacts;
create policy mm_personal_data_20261031130000_alert_contacts_insert_own on public.alert_contacts
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_alert_contacts_update_own on public.alert_contacts;
create policy mm_personal_data_20261031130000_alert_contacts_update_own on public.alert_contacts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_alert_contacts_delete_own on public.alert_contacts;
create policy mm_personal_data_20261031130000_alert_contacts_delete_own on public.alert_contacts
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_media_items_select_own on public.media_items;
create policy mm_personal_data_20261031130000_media_items_select_own on public.media_items
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_media_items_insert_own on public.media_items;
create policy mm_personal_data_20261031130000_media_items_insert_own on public.media_items
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_media_items_update_own on public.media_items;
create policy mm_personal_data_20261031130000_media_items_update_own on public.media_items
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_media_items_delete_own on public.media_items;
create policy mm_personal_data_20261031130000_media_items_delete_own on public.media_items
  for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists mm_personal_data_20261031130000_user_preferences_select_own on public.user_preferences;
create policy mm_personal_data_20261031130000_user_preferences_select_own on public.user_preferences
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_user_preferences_insert_own on public.user_preferences;
create policy mm_personal_data_20261031130000_user_preferences_insert_own on public.user_preferences
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mm_personal_data_20261031130000_user_preferences_update_own on public.user_preferences;
create policy mm_personal_data_20261031130000_user_preferences_update_own on public.user_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- PIN hashes are intentionally server-only. Browser roles receive no privileges.
revoke all on table private.profile_secrets from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on private.profile_secrets to service_role;
revoke all on function public.mm_personal_data_20261031130000_set_updated_at() from public, anon, authenticated;
revoke all on function public.mm_personal_data_20261031130000_validate_session_profile() from public, anon, authenticated;

revoke all on table public.app_users from public, anon;
revoke all on table public.profiles from public, anon;
revoke all on table public.device_sessions from public, anon;
revoke all on table public.memories from public, anon;
revoke all on table public.memory_assets from public, anon;
revoke all on table public.alert_contacts from public, anon;
revoke all on table public.media_items from public, anon;
revoke all on table public.user_preferences from public, anon;

grant select, insert, update on public.app_users to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.device_sessions to authenticated;
grant select, insert, update, delete on public.memories to authenticated;
grant select, insert, update, delete on public.memory_assets to authenticated;
grant select, insert, update, delete on public.alert_contacts to authenticated;
grant select, insert, update, delete on public.media_items to authenticated;
grant select, insert, update on public.user_preferences to authenticated;
