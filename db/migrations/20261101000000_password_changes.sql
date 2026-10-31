-- Lets admins change their own password, and ends older sessions when they do.
alter table auth.users add column password_changed_at timestamptz not null default now();

grant update (password_hash, password_changed_at) on auth.users to service_role;
