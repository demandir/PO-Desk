import { readdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Run the actual migrations and PostgreSQL policies.
let db: PGlite
const migrations = new URL('../db/migrations/', import.meta.url)
const operations = '00000000-0000-4000-8000-000000000001'
const technology = '00000000-0000-4000-8000-000000000002'
const operationsAdmin = '20000000-0000-4000-8000-000000000001'
const technologyAdmin = '20000000-0000-4000-8000-000000000002'
const globalAdmin = '20000000-0000-4000-8000-000000000003'
const unassignedUser = '20000000-0000-4000-8000-000000000004'
const code = '7K2M-B4WN'
const otherCode = '4H7P-8R2W'

const asRole = async (role: 'anon' | 'authenticated' | 'service_role', userId = '') => {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
  await db.exec(`set local role ${role}`)
}

const draft = (departmentId = operations) => ({
  requesterName: 'Test Requester', departmentId,
  vendorName: 'Test Vendor', vendorUrl: '', costCenter: '',
  businessReason: 'Restock office supplies.',
  items: [{ description: 'Paper', quantity: 3, unitPrice: 10.01 }],
  currency: 'USD', website: '',
})

const submit = async (payload = draft(), requestCode = code, key = randomUUID()) => {
  await asRole('service_role')
  const receipt = await db.query<{ reference: string; submitted_at: Date }>(
    'select * from public.submit_purchase_order_service($1::jsonb, $2, $3::uuid)',
    [JSON.stringify(payload), requestCode, key],
  )
  await db.exec('reset role')
  const order = await db.query<{ id: string }>(
    'select id from public.purchase_orders where idempotency_key = $1', [key],
  )
  return { ...receipt.rows[0], id: order.rows[0]!.id, key }
}

const rejected = async (sql: string, params: unknown[] = [], message?: string | RegExp) => {
  await db.exec('savepoint expected_failure')
  await expect(db.query(sql, params)).rejects.toThrow(message)
  await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure')
}

beforeAll(async () => {
  db = new PGlite()
  for (const name of (await readdir(migrations)).sort()) await db.exec(await readFile(new URL(name, migrations), 'utf8'))
  await db.exec(`
    insert into public.departments(id, name, code) values ('${technology}', 'Technology', 'TECH');
    insert into auth.users(id, username, password_hash) values
      ('${operationsAdmin}', 'operations', 'x'), ('${technologyAdmin}', 'technology', 'x'),
      ('${globalAdmin}', 'admin', 'x'), ('${unassignedUser}', 'unassigned', 'x');
    insert into public.profiles(user_id, full_name, role, department_id) values
      ('${operationsAdmin}', 'Operations Admin', 'department_admin', '${operations}'),
      ('${technologyAdmin}', 'Technology Admin', 'department_admin', '${technology}'),
      ('${globalAdmin}', 'Company Admin', 'global_admin', null);
  `)
}, 20000)

beforeEach(async () => {
  await db.exec('begin')
})
afterEach(async () => { await db.exec('rollback') })
afterAll(async () => { await db.close() })

describe('database permissions', () => {
  it('allows anonymous department choices but denies order data and privileged RPCs', async () => {
    const order = await submit()
    await asRole('anon')
    expect((await db.query('select id from public.departments')).rows).toHaveLength(2)
    for (const table of ['purchase_orders', 'purchase_order_items', 'audit_events', 'profiles']) {
      await rejected(`select * from public.${table}`, [], /permission denied/)
    }
    await rejected('select * from public.submit_purchase_order_service($1::jsonb,$2,$3::uuid)',
      [JSON.stringify(draft()), otherCode, randomUUID()], /permission denied/)
    await rejected("select public.transition_purchase_order($1,'approved','')", [order.id], /permission denied/)
  })

  it('scopes requests, items, audit history, and profiles to the signed-in department', async () => {
    const own = await submit()
    await submit(draft(technology), otherCode)
    await asRole('authenticated', operationsAdmin)
    expect((await db.query('select id from public.purchase_orders')).rows).toEqual([{ id: own.id }])
    expect((await db.query('select purchase_order_id from public.purchase_order_items')).rows)
      .toEqual([{ purchase_order_id: own.id }])
    expect((await db.query('select purchase_order_id from public.audit_events')).rows)
      .toEqual([{ purchase_order_id: own.id }])
    expect((await db.query('select user_id from public.profiles')).rows).toEqual([{ user_id: operationsAdmin }])
    await rejected("update public.purchase_orders set status = 'approved' where id = $1", [own.id], /permission denied/)
    await rejected("update public.profiles set role = 'global_admin'", [], /permission denied/)
    await rejected("insert into public.departments(name,code) values ('Unauthorized','NO')", [], /row-level security/)
  })

  it('gives unassigned authenticated users no orders and no transition authority', async () => {
    const order = await submit()
    await asRole('authenticated', unassignedUser)
    expect((await db.query('select id from public.purchase_orders')).rows).toHaveLength(0)
    await rejected("select public.transition_purchase_order($1,'approved','')", [order.id], /profile required/)
  })

  it('rejects a cross-department transition without changing status or audit history', async () => {
    const order = await submit(draft(technology))
    await asRole('authenticated', operationsAdmin)
    await rejected("select public.transition_purchase_order($1,'approved','')", [order.id], /another department/)
    await db.exec('reset role')
    expect((await db.query('select status from public.purchase_orders where id = $1', [order.id])).rows)
      .toEqual([{ status: 'submitted' }])
    expect((await db.query('select id from public.audit_events where purchase_order_id = $1', [order.id])).rows)
      .toHaveLength(1)
  })

  it('allows global review across departments and creation of new departments', async () => {
    await submit()
    const other = await submit(draft(technology), otherCode)
    await asRole('authenticated', globalAdmin)
    expect((await db.query('select id from public.purchase_orders')).rows).toHaveLength(2)
    await db.query("select public.transition_purchase_order($1,'approved','Approved by company admin')", [other.id])
    await db.exec("insert into public.departments(name,code) values ('Facilities','FAC')")
    expect((await db.query("select code from public.departments where code = 'FAC'")).rows).toHaveLength(1)
  })
})

describe('purchase-order transactions', () => {
  it('still accepts an earlier long request code', async () => {
    await expect(submit(draft(), 'REQ-7K2M-B4WN-9Q3R-6T8Y')).resolves.toBeDefined()
  })

  it('rejects a malformed request code', async () => {
    await asRole('service_role')
    await rejected(
      'select * from public.submit_purchase_order_service($1::jsonb, $2, $3::uuid)',
      [JSON.stringify(draft()), '7K2M-B4W', randomUUID()],
      /Invalid request code/,
    )
  })

  it('stores matching rounded line/order totals and only a hash of the request code', async () => {
    const payload = draft()
    payload.items.push({ description: 'Material by length', quantity: 1.25, unitPrice: 3.33 })
    const order = await submit(payload)
    const row = (await db.query<{ subtotal: string; total: string; line_sum: string; request_code_hash: string }>(`
      select po.subtotal, po.total, po.request_code_hash, sum(i.line_total)::text as line_sum
      from public.purchase_orders po join public.purchase_order_items i on i.purchase_order_id = po.id
      where po.id = $1 group by po.id`, [order.id])).rows[0]!
    expect(Number(row.subtotal)).toBe(34.19)
    expect(Number(row.line_sum)).toBe(Number(row.subtotal))
    expect(Number(row.total)).toBe(Number(row.line_sum))
    expect(row.request_code_hash).toBe(createHash('sha256').update(code).digest('hex'))
  })

  it('returns the original receipt on retry and rejects a different code for the same identity', async () => {
    const first = await submit()
    const retry = await submit(draft(), code, first.key)
    expect(retry.id).toBe(first.id)
    expect(retry.reference).toBe(first.reference)
    expect(retry.submitted_at).toEqual(first.submitted_at)
    expect((await db.query('select id from public.purchase_orders')).rows).toHaveLength(1)
    expect((await db.query('select id from public.audit_events')).rows).toHaveLength(1)
    await asRole('service_role')
    await rejected('select * from public.submit_purchase_order_service($1::jsonb,$2,$3::uuid)',
      [JSON.stringify(draft()), otherCode, first.key], /does not match/)
  })

  it('rejects invalid, missing, negative, or overprecise numeric values atomically', async () => {
    const base = draft()
    const invalid = [
      { ...base, items: [{ ...base.items[0], quantity: null }] },
      { ...base, items: [{ ...base.items[0], quantity: 0.001 }] },
      { ...base, items: [{ ...base.items[0], unitPrice: 10.005 }] },
      { ...base, items: [{ ...base.items[0], unitPrice: 'NaN' }] },
      { ...base, items: [{ ...base.items[0], quantity: -1 }] },
      { ...base, items: [{ ...base.items[0], unitPrice: -1 }] },
      { ...base, items: null }, { ...base, items: [null] }, { ...base, requesterName: null },
      { ...base, currency: 'EUR' },
    ]
    await asRole('service_role')
    for (const payload of invalid) {
      await rejected('select * from public.submit_purchase_order_service($1::jsonb,$2,$3::uuid)',
        [JSON.stringify(payload), code, randomUUID()])
    }
    await db.exec('reset role')
    expect((await db.query('select id from public.purchase_orders')).rows).toHaveLength(0)
    expect((await db.query('select id from public.purchase_order_items')).rows).toHaveLength(0)
    expect((await db.query('select id from public.audit_events')).rows).toHaveLength(0)
  })

  it('accepts the minimal request without contact, delivery, or added charges', async () => {
    const minimal = {
      requesterName: 'Test Requester', departmentId: operations,
      vendorName: 'Test Vendor', businessReason: 'Restock office supplies.',
      items: [{ description: 'Paper', quantity: 3, unitPrice: 10.01 }], currency: 'USD',
    }
    await asRole('service_role')
    await db.query('select * from public.submit_purchase_order_service($1::jsonb,$2,$3::uuid)',
      [JSON.stringify(minimal), code, randomUUID()])
    expect((await db.query('select total::text, subtotal::text from public.purchase_orders')).rows)
      .toEqual([{ total: '30.03', subtotal: '30.03' }])
    await db.exec('reset role')
    const columns = (await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'purchase_orders'",
    )).rows.map((row) => row.column_name)
    for (const removed of ['requester_email', 'needed_by', 'delivery_location', 'shipping', 'tax']) {
      expect(columns).not.toContain(removed)
    }
  })

  it('enforces decisions, appends history, and keeps history immutable', async () => {
    const order = await submit()
    await asRole('authenticated', operationsAdmin)
    await rejected("select public.transition_purchase_order($1,'rejected',null)", [order.id], /note is required/)
    await rejected('select public.transition_purchase_order($1,null,\'\')', [order.id], /not allowed/)
    await db.query("select public.transition_purchase_order($1,'approved',null)", [order.id])
    await db.query("select public.transition_purchase_order($1,'ordered','Order placed')", [order.id])
    await rejected("select public.transition_purchase_order($1,'under_review','')", [order.id], /not allowed/)
    const history = await db.query('select new_status, actor_name, note from public.audit_events where purchase_order_id = $1 order by new_status', [order.id])
    expect(history.rows).toEqual([
      { new_status: 'submitted', actor_name: 'Test Requester', note: 'Purchase request submitted.' },
      { new_status: 'approved', actor_name: 'Operations Admin', note: '' },
      { new_status: 'ordered', actor_name: 'Operations Admin', note: 'Order placed' },
    ])
    await db.exec('reset role')
    await rejected('delete from public.audit_events where purchase_order_id = $1', [order.id], /append-only/)
  })

  it('keeps references unique once the sequence exceeds five digits', async () => {
    await db.exec("select setval('public.po_reference_sequence', 99999, false)")
    const a = await submit()
    const b = await submit(draft(technology), otherCode)
    expect(a.reference).toMatch(/-99999$/)
    expect(b.reference).toMatch(/-100000$/)
  })
})

describe('rate limits', () => {
  it('rejects requests over quota, resets expired windows, and restricts access', async () => {
    await asRole('service_role')
    const claim = () => db.query<{ allowed: boolean }>("select public.claim_rate_limit('submit-po','test-client',2) as allowed")
    expect((await claim()).rows[0]!.allowed).toBe(true)
    expect((await claim()).rows[0]!.allowed).toBe(true)
    expect((await claim()).rows[0]!.allowed).toBe(false)
    await db.exec('reset role')
    await db.exec("update private.rate_limit_buckets set window_start = now() - interval '2 hours'")
    await asRole('service_role')
    expect((await claim()).rows[0]!.allowed).toBe(true)
    await asRole('authenticated', operationsAdmin)
    await rejected("select public.claim_rate_limit('submit-po','test-client',2)", [], /permission denied/)
  })
})
