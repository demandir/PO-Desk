-- Anyone in the connected Telegram group can decide requests. Telegram accounts are
-- no longer tied to admin logins.
drop trigger if exists users_end_telegram_links on auth.users;
drop function if exists private.end_telegram_links();
drop table if exists public.telegram_admins;
drop table if exists public.telegram_link_codes;

-- One-time codes that connect a group. Created with npm run telegram:connect.
create table public.telegram_group_codes (
  code_hash text primary key check (char_length(code_hash) = 64),
  expires_at timestamptz not null
);

-- A group member who tapped Accept or Deny and still owes a reason.
create table public.telegram_pending_decisions (
  telegram_user_id bigint primary key,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  target_status public.order_status not null check (target_status in ('approved', 'rejected')),
  chat_id bigint not null,
  prompt_message_id bigint,
  expires_at timestamptz not null
);

alter table public.telegram_group_codes enable row level security;
alter table public.telegram_pending_decisions enable row level security;
revoke all on public.telegram_group_codes, public.telegram_pending_decisions from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_group_codes, public.telegram_pending_decisions to service_role;

-- The same status rules as transition_purchase_order, for a decision made in the
-- group. The audit record names the Telegram user, and a reason is always required.
create function public.transition_purchase_order_from_telegram(
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text,
  p_actor_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.purchase_orders%rowtype;
  v_allowed boolean := false;
begin
  if char_length(btrim(coalesce(p_actor_name, ''))) not between 1 and 100 then
    raise exception 'Invalid decision maker';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'A decision note is required';
  end if;
  if char_length(p_note) > 1000 then
    raise exception 'Decision note is too long';
  end if;

  select * into v_order
  from public.purchase_orders po
  where po.id = p_order_id
  for update;
  if not found then
    raise exception 'Purchase request not found';
  end if;

  v_allowed := case v_order.status
    when 'submitted' then p_target_status in ('approved', 'rejected')
    when 'under_review' then p_target_status in ('approved', 'rejected')
    when 'needs_information' then p_target_status in ('approved', 'rejected')
    else false
  end;
  if v_allowed is not true then
    raise exception 'Status transition is not allowed';
  end if;

  update public.purchase_orders
  set status = p_target_status
  where id = p_order_id;

  insert into public.audit_events (
    purchase_order_id,
    actor_name,
    action,
    previous_status,
    new_status,
    note
  ) values (
    p_order_id,
    btrim(p_actor_name),
    'status_changed',
    v_order.status,
    p_target_status,
    btrim(p_note)
  );
end;
$$;

revoke all on function public.transition_purchase_order_from_telegram(uuid, public.order_status, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_purchase_order_from_telegram(uuid, public.order_status, text, text)
  to service_role;
