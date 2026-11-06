-- All requests are posted in one Telegram group. Admins still connect their own
-- Telegram accounts, so the bot knows which admin tapped a button.
create table public.telegram_group (
  singleton boolean primary key default true check (singleton),
  chat_id bigint not null,
  connected_at timestamptz not null default now()
);

alter table public.telegram_group enable row level security;
revoke all on public.telegram_group from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_group to service_role;

-- Where the reason question was asked, so only a reply to it counts in the group.
alter table public.telegram_admins
  add column pending_chat_id bigint,
  add column pending_prompt_id bigint;

-- Earlier alerts were private messages to each admin.
delete from public.telegram_order_alerts;
