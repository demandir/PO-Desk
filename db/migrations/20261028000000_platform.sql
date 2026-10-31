-- Roles and identity used by the row-level security policies. The API sets the
-- role and user id for each transaction, so these roles never log in directly.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute format('create role %I nologin', v_role);
    end if;
    execute format('grant %I to current_user', v_role);
  end loop;
end;
$$;

alter role service_role bypassrls;

create schema if not exists auth;
revoke all on schema auth from public;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9]{2,32}$'),
  password_hash text not null,
  created_at timestamptz not null default now()
);

revoke all on auth.users from public, anon, authenticated;
grant select on auth.users to service_role;

create function auth.uid()
returns uuid
language sql
stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
