create type public.admin_role as enum ('department_admin', 'global_admin');
create type public.order_status as enum (
  'submitted',
  'under_review',
  'needs_information',
  'approved',
  'rejected',
  'ordered'
);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create sequence public.po_reference_sequence start 1;

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  code text not null unique check (code ~ '^[A-Z0-9-]{2,8}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 100),
  role public.admin_role not null,
  department_id uuid references public.departments(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_role_department_check check (
    (role = 'global_admin' and department_id is null)
    or (role = 'department_admin' and department_id is not null)
  )
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  department_id uuid not null references public.departments(id),
  requester_name text not null check (char_length(btrim(requester_name)) between 1 and 100),
  vendor_name text not null check (char_length(btrim(vendor_name)) between 1 and 150),
  vendor_url text not null default '' check (char_length(vendor_url) <= 500),
  cost_center text not null default '' check (char_length(cost_center) <= 50),
  business_reason text not null check (char_length(btrim(business_reason)) between 10 and 2000),
  currency text not null default 'USD' check (currency = 'USD'),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  total numeric(14,2) not null default 0 check (total >= 0),
  status public.order_status not null default 'submitted',
  request_code_hash text not null unique check (char_length(request_code_hash) = 64),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  position smallint not null check (position between 1 and 25),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  quantity numeric(12,2) not null check (quantity > 0 and quantity <= 10000),
  unit_price numeric(14,2) not null check (unit_price >= 0 and unit_price <= 10000000),
  line_total numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  unique (purchase_order_id, position)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text not null check (char_length(btrim(actor_name)) between 1 and 100),
  action text not null check (action in ('submitted', 'status_changed')),
  previous_status public.order_status,
  new_status public.order_status not null,
  note text not null default '' check (char_length(note) <= 1000),
  created_at timestamptz not null default now()
);

create table private.rate_limit_buckets (
  bucket text not null,
  fingerprint text not null,
  window_start timestamptz not null default now(),
  request_count integer not null default 0,
  primary key (bucket, fingerprint)
);

create index purchase_orders_department_created_idx
  on public.purchase_orders (department_id, created_at desc);
create index purchase_orders_status_created_idx
  on public.purchase_orders (status, created_at desc);
create index purchase_order_items_order_idx
  on public.purchase_order_items (purchase_order_id, position);
create index audit_events_order_created_idx
  on public.audit_events (purchase_order_id, created_at desc);
create index profiles_department_idx
  on public.profiles (department_id) where department_id is not null;

create or replace function private.current_admin_role()
returns public.admin_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.user_id = (select auth.uid())
$$;

create or replace function private.current_department_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.department_id
  from public.profiles p
  where p.user_id = (select auth.uid())
$$;

revoke all on function private.current_admin_role() from public;
revoke all on function private.current_department_id() from public;
grant usage on schema private to authenticated, service_role;
grant execute on function private.current_admin_role() to authenticated, service_role;
grant execute on function private.current_department_id() to authenticated, service_role;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger departments_touch_updated_at
before update on public.departments
for each row execute function private.touch_updated_at();

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

create trigger purchase_orders_touch_updated_at
before update on public.purchase_orders
for each row execute function private.touch_updated_at();

create or replace function private.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Audit events are append-only';
end;
$$;

create trigger audit_events_no_update
before update or delete on public.audit_events
for each row execute function private.prevent_audit_mutation();

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.departments from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
revoke all on public.purchase_orders from anon, authenticated;
revoke all on public.purchase_order_items from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;

grant select on public.departments to anon, authenticated;
grant insert on public.departments to authenticated;
grant select on public.profiles to authenticated;
grant select on public.purchase_orders to authenticated;
grant select on public.purchase_order_items to authenticated;
grant select on public.audit_events to authenticated;
-- Edge Functions use this role for status lookup; do not rely on project defaults.
grant select on public.purchase_orders to service_role;

create policy departments_public_read
on public.departments for select
to anon
using (active = true);

create policy departments_authenticated_read
on public.departments for select
to authenticated
using (active = true or (select private.current_admin_role()) = 'global_admin');

create policy departments_global_insert
on public.departments for insert
to authenticated
with check ((select private.current_admin_role()) = 'global_admin');

create policy profiles_self_read
on public.profiles for select
to authenticated
using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy orders_scoped_read
on public.purchase_orders for select
to authenticated
using (
  (select private.current_admin_role()) = 'global_admin'
  or department_id = (select private.current_department_id())
);

create policy items_scoped_read
on public.purchase_order_items for select
to authenticated
using (
  exists (
    select 1
    from public.purchase_orders po
    where po.id = purchase_order_items.purchase_order_id
  )
);

create policy audit_scoped_read
on public.audit_events for select
to authenticated
using (
  exists (
    select 1
    from public.purchase_orders po
    where po.id = audit_events.purchase_order_id
  )
);

create or replace function public.next_po_reference()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'PO-' || to_char(current_date, 'YY') || '-' ||
    lpad(sequence_value, greatest(5, char_length(sequence_value)), '0')
  from (select nextval('public.po_reference_sequence')::text as sequence_value) next_reference
$$;

revoke all on function public.next_po_reference() from public, anon, authenticated;
grant execute on function public.next_po_reference() to service_role;

create or replace function public.claim_rate_limit(
  p_bucket text,
  p_fingerprint text,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 40
     or p_fingerprint is null or char_length(p_fingerprint) not between 1 and 128
     or p_limit is null or p_limit < 1 then
    return false;
  end if;
  insert into private.rate_limit_buckets as limits (
    bucket,
    fingerprint,
    window_start,
    request_count
  ) values (
    p_bucket,
    p_fingerprint,
    now(),
    1
  )
  on conflict (bucket, fingerprint) do update
    set window_start = case
          when limits.window_start < now() - interval '1 hour' then now()
          else limits.window_start
        end,
        request_count = case
          when limits.window_start < now() - interval '1 hour' then 1
          else limits.request_count + 1
        end
  returning request_count into v_count;

  return v_count <= greatest(1, least(p_limit, 200));
end;
$$;

revoke all on function public.claim_rate_limit(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_rate_limit(text, text, integer) to service_role;

create or replace function public.submit_purchase_order_service(
  p_request jsonb,
  p_request_code text,
  p_idempotency_key uuid
)
returns table (reference text, submitted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.purchase_orders%rowtype;
  v_order_id uuid;
  v_reference text;
  v_subtotal numeric(14,2) := 0;
  v_total numeric(14,2);
  v_submitted_at timestamptz;
  v_item jsonb;
  v_position integer := 0;
  v_department_id uuid;
  v_requester_name text;
  v_code_hash text;
  v_quantity numeric;
  v_unit_price numeric;
begin
  if p_request_code is null or p_request_code !~ '^REQ-[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$' then
    raise exception 'Invalid request code';
  end if;
  if p_idempotency_key is null then
    raise exception 'Invalid submission identity';
  end if;
  v_code_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_request_code, 'UTF8')), 'hex');

  -- Serialize retries for the same submission before checking for an existing row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 0));

  select * into v_existing
  from public.purchase_orders po
  where po.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_code_hash <> v_code_hash then
      raise exception 'Submission identity does not match the original request';
    end if;
    return query select v_existing.reference, v_existing.created_at;
    return;
  end if;

  if jsonb_typeof(p_request) is distinct from 'object'
     or jsonb_typeof(p_request->'items') is distinct from 'array' then
    raise exception 'A request must contain between 1 and 25 items';
  end if;
  if jsonb_array_length(p_request->'items') not between 1 and 25 then
    raise exception 'A request must contain between 1 and 25 items';
  end if;

  v_department_id := (p_request->>'departmentId')::uuid;
  if not exists (
    select 1 from public.departments d where d.id = v_department_id and d.active = true
  ) then
    raise exception 'Department is not active';
  end if;

  v_requester_name := btrim(coalesce(p_request->>'requesterName', ''));
  if char_length(v_requester_name) not between 1 and 100 then
    raise exception 'Invalid requester name';
  end if;
  if char_length(btrim(coalesce(p_request->>'vendorName', ''))) not between 1 and 150 then
    raise exception 'Invalid vendor';
  end if;
  if coalesce(p_request->>'vendorUrl', '') <> ''
     and coalesce(p_request->>'vendorUrl', '') !~* '^https://' then
    raise exception 'Vendor URL must use HTTPS';
  end if;
  if char_length(btrim(coalesce(p_request->>'businessReason', ''))) not between 10 and 2000 then
    raise exception 'Invalid business reason';
  end if;
  if coalesce(p_request->>'currency', '') <> 'USD'
     or coalesce(p_request->>'website', '') <> '' then
    raise exception 'Invalid purchase request';
  end if;

  for v_item in select value from jsonb_array_elements(p_request->'items') loop
    v_position := v_position + 1;
    if char_length(btrim(coalesce(v_item->>'description', ''))) not between 1 and 500 then
      raise exception 'Invalid item description';
    end if;
    if jsonb_typeof(v_item->'quantity') is distinct from 'number'
       or jsonb_typeof(v_item->'unitPrice') is distinct from 'number' then
      raise exception 'Invalid item quantity or price';
    end if;
    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := (v_item->>'unitPrice')::numeric;
    if v_quantity <= 0 or v_quantity > 10000 or v_quantity <> round(v_quantity, 2) then
      raise exception 'Invalid item quantity';
    end if;
    if v_unit_price < 0 or v_unit_price > 10000000 or v_unit_price <> round(v_unit_price, 2) then
      raise exception 'Invalid unit price';
    end if;
    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 2);
  end loop;

  v_total := v_subtotal;
  if v_total > 10000000 then
    raise exception 'Request total exceeds the supported limit';
  end if;

  v_reference := public.next_po_reference();
  insert into public.purchase_orders (
    reference,
    department_id,
    requester_name,
    vendor_name,
    vendor_url,
    cost_center,
    business_reason,
    currency,
    subtotal,
    total,
    request_code_hash,
    idempotency_key
  ) values (
    v_reference,
    v_department_id,
    v_requester_name,
    btrim(p_request->>'vendorName'),
    btrim(coalesce(p_request->>'vendorUrl', '')),
    btrim(coalesce(p_request->>'costCenter', '')),
    btrim(p_request->>'businessReason'),
    'USD',
    v_subtotal,
    v_total,
    v_code_hash,
    p_idempotency_key
  ) returning id, created_at into v_order_id, v_submitted_at;

  v_position := 0;
  for v_item in select value from jsonb_array_elements(p_request->'items') loop
    v_position := v_position + 1;
    insert into public.purchase_order_items (
      purchase_order_id,
      position,
      description,
      quantity,
      unit_price
    ) values (
      v_order_id,
      v_position,
      btrim(v_item->>'description'),
      (v_item->>'quantity')::numeric,
      (v_item->>'unitPrice')::numeric
    );
  end loop;

  insert into public.audit_events (
    purchase_order_id,
    actor_name,
    action,
    previous_status,
    new_status,
    note
  ) values (
    v_order_id,
    v_requester_name,
    'submitted',
    null,
    'submitted',
    'Purchase request submitted.'
  );

  return query select v_reference, v_submitted_at;
end;
$$;

revoke all on function public.submit_purchase_order_service(jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_purchase_order_service(jsonb, text, uuid)
  to service_role;

create or replace function public.transition_purchase_order(
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.purchase_orders%rowtype;
  v_profile public.profiles%rowtype;
  v_allowed boolean := false;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles p
  where p.user_id = (select auth.uid());
  if not found then
    raise exception 'Administrator profile required';
  end if;

  select * into v_order
  from public.purchase_orders po
  where po.id = p_order_id
  for update;
  if not found then
    raise exception 'Purchase request not found';
  end if;
  if v_profile.role <> 'global_admin' and v_profile.department_id is distinct from v_order.department_id then
    raise exception 'Purchase request belongs to another department';
  end if;

  v_allowed := case v_order.status
    when 'submitted' then p_target_status in ('under_review', 'needs_information', 'approved', 'rejected')
    when 'under_review' then p_target_status in ('needs_information', 'approved', 'rejected')
    when 'needs_information' then p_target_status in ('under_review', 'approved', 'rejected')
    when 'approved' then p_target_status = 'ordered'
    when 'rejected' then p_target_status = 'under_review'
    else false
  end;
  if v_allowed is not true then
    raise exception 'Status transition is not allowed';
  end if;
  if p_target_status in ('needs_information', 'rejected') and char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'A decision note is required';
  end if;
  if char_length(p_note) > 1000 then
    raise exception 'Decision note is too long';
  end if;

  update public.purchase_orders
  set status = p_target_status
  where id = p_order_id;

  insert into public.audit_events (
    purchase_order_id,
    actor_user_id,
    actor_name,
    action,
    previous_status,
    new_status,
    note
  ) values (
    p_order_id,
    v_profile.user_id,
    v_profile.full_name,
    'status_changed',
    v_order.status,
    p_target_status,
    btrim(coalesce(p_note, ''))
  );
end;
$$;

revoke all on function public.transition_purchase_order(uuid, public.order_status, text)
  from public, anon;
grant execute on function public.transition_purchase_order(uuid, public.order_status, text)
  to authenticated;

insert into public.departments (id, name, code)
values ('00000000-0000-4000-8000-000000000001', 'General', 'GEN')
on conflict (code) do nothing;
