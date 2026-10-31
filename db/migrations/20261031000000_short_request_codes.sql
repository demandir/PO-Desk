-- New request codes are two blocks (XXXX-XXXX). Earlier REQ- codes stay valid.
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
  if p_request_code is null or p_request_code !~ '^(REQ-([2-9A-HJ-NP-Z]{4}-){2})?[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$' then
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
