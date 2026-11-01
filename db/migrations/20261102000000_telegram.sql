-- Telegram bot state. Only the API's service role touches these tables.
create table public.telegram_link_codes (
  code_hash text primary key check (char_length(code_hash) = 64),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  expires_at timestamptz not null
);

-- One department login can be connected to several Telegram accounts. In a
-- private chat, the Telegram user id and the chat id are the same number.
create table public.telegram_admins (
  telegram_user_id bigint primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  linked_at timestamptz not null default now(),
  pending_order_id uuid references public.purchase_orders(id) on delete set null,
  pending_status public.order_status check (pending_status in ('approved', 'rejected')),
  pending_until timestamptz
);

create table public.telegram_order_alerts (
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  chat_id bigint not null,
  message_id bigint,
  primary key (purchase_order_id, chat_id)
);

create table public.telegram_order_followers (
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  chat_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (purchase_order_id, chat_id)
);

create index telegram_admins_user_idx on public.telegram_admins (user_id);
create index telegram_order_followers_chat_idx on public.telegram_order_followers (chat_id);

alter table public.telegram_link_codes enable row level security;
alter table public.telegram_admins enable row level security;
alter table public.telegram_order_alerts enable row level security;
alter table public.telegram_order_followers enable row level security;

revoke all on public.telegram_link_codes, public.telegram_admins,
  public.telegram_order_alerts, public.telegram_order_followers
  from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_link_codes, public.telegram_admins,
  public.telegram_order_alerts, public.telegram_order_followers
  to service_role;
grant select on public.departments, public.profiles, public.purchase_order_items, public.audit_events
  to service_role;

-- A new password ends Telegram connections as well as web sessions.
create function private.end_telegram_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.telegram_admins where user_id = new.id;
  delete from public.telegram_link_codes where user_id = new.id;
  return new;
end;
$$;

revoke all on function private.end_telegram_links() from public;

create trigger users_end_telegram_links
after update of password_hash on auth.users
for each row execute function private.end_telegram_links();
