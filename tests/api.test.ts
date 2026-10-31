import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi, type Database } from '../functions/handler'
import { hashPassword } from '../functions/password'

// The real API handler against the real migrations.
const origin = 'https://shailp08.github.io'
const migrations = new URL('../db/migrations/', import.meta.url)
let db: PGlite
let api: (request: Request) => Promise<Response>
let departments: Record<string, string>

const call = async (path: string, options: { body?: unknown; token?: string; origin?: string | null; ip?: string } = {}) => {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? '203.0.113.1' }
  if (options.origin !== null) headers.origin = options.origin ?? origin
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await api(new Request(`https://api.test${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }))
  return { status: response.status, body: await response.json() as Record<string, any> }
}

const signIn = async (username: string) =>
  (await call('/login', { body: { username, password: `${username}-password` } })).body.token as string

const submit = (departmentId: string, requestCode: string, requesterName = 'Test Requester') => call('/submit', {
  body: {
    requestCode,
    idempotencyKey: randomUUID(),
    request: {
      requesterName, departmentId, vendorName: 'Vendor', vendorUrl: '', costCenter: '',
      businessReason: 'Restocking supplies for the hall.', currency: 'USD', website: '',
      items: [{ description: 'Paper', quantity: 2, unitPrice: 12.5 }],
    },
  },
})

beforeAll(async () => {
  db = new PGlite()
  for (const name of (await readdir(migrations)).sort()) await db.exec(await readFile(new URL(name, migrations), 'utf8'))
  await db.exec(await readFile(new URL('../db/delmandir.sql', import.meta.url), 'utf8'))
  const rows = (await db.query<{ id: string; code: string }>('select id, code from public.departments')).rows
  departments = Object.fromEntries(rows.map(({ id, code }) => [code, id]))
  const accounts = [['admin', null], ['facilities', 'FAC'], ['capa', 'CAPA'], ['noprofile', undefined]] as const
  for (const [username, code] of accounts) {
    const hash = await hashPassword(`${username}-password`)
    const user = await db.query<{ id: string }>('insert into auth.users (username, password_hash) values ($1, $2) returning id', [username, hash])
    if (code === undefined) continue
    await db.query(
      `insert into public.profiles (user_id, full_name, role, department_id) values ($1, $2, $3::public.admin_role, $4)`,
      [user.rows[0]!.id, username, code ? 'department_admin' : 'global_admin', code ? departments[code] : null],
    )
  }
  const database: Database = {
    transaction: (run) => db.transaction((tx) => run((sql, params) => tx.query(sql, params))) as never,
  }
  api = createApi({ database, allowedOrigins: [origin], authSecret: 'test-secret-test-secret-test-secret', rateLimitSalt: 'salt' })
}, 30000)

afterAll(async () => { await db.close() })

describe('API', () => {
  it('lists only active departments to anonymous visitors', async () => {
    const { body } = await call('/departments')
    const names = body.departments.map((department: { name: string }) => department.name)
    expect(names).toEqual(['AV/IT', 'Accounting', 'CAPA', 'Facilities', 'Mahila', 'Satsang', 'Service'])
  })

  it('rejects other origins', async () => {
    expect((await call('/departments', { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('signs in with a username and refuses wrong or unknown credentials the same way', async () => {
    const good = await call('/login', { body: { username: 'Facilities', password: 'facilities-password' } })
    expect(good.status).toBe(200)
    expect(good.body.profile.departments.name).toBe('Facilities')
    const wrong = await call('/login', { body: { username: 'capa', password: 'nope' } })
    const unknown = await call('/login', { body: { username: 'nobody', password: 'nope' } })
    expect(wrong.status).toBe(401)
    expect(unknown).toEqual(wrong)
    expect(JSON.stringify(good.body)).not.toContain('scrypt')
  })

  it('blocks an account without an admin profile', async () => {
    expect((await call('/login', { body: { username: 'noprofile', password: 'noprofile-password' } })).status).toBe(403)
  })

  it('limits repeated password guesses even from changing addresses', async () => {
    let last = 0
    for (let attempt = 0; attempt < 16; attempt += 1) {
      last = (await call('/login', { body: { username: 'noprofile', password: 'x' }, ip: `198.51.100.${attempt}` })).status
    }
    expect(last).toBe(429)
  })

  it('requires a valid token for admin data', async () => {
    expect((await call('/orders')).status).toBe(401)
    expect((await call('/orders', { token: 'forged.token.value' })).status).toBe(401)
  })

  it('keeps each department to its own requests and lets the super-admin see all', async () => {
    expect((await submit(departments.FAC!, 'AAAA-AAAA', 'Facilities Requester')).status).toBe(201)
    expect((await submit(departments.CAPA!, 'BBBB-BBBB', 'CAPA Requester')).status).toBe(201)
    const facilities = await signIn('facilities')
    const capa = await signIn('capa')
    const admin = await signIn('admin')
    const requesters = async (token: string) =>
      (await call('/orders', { token })).body.orders.map((order: { requester_name: string }) => order.requester_name).sort()
    expect(await requesters(facilities)).toEqual(['Facilities Requester'])
    expect(await requesters(capa)).toEqual(['CAPA Requester'])
    expect(await requesters(admin)).toEqual(['CAPA Requester', 'Facilities Requester'])
    const [order] = (await call('/orders', { token: facilities })).body.orders
    expect(order.purchase_order_items).toHaveLength(1)
    expect(order.audit_events).toHaveLength(1)
    expect(order).not.toHaveProperty('request_code_hash')
    expect(order.total).toBe('25.00')
  })

  it('stops a department admin from changing another department and allows their own', async () => {
    const admin = await signIn('admin')
    const orders = (await call('/orders', { token: admin })).body.orders as { id: string; requester_name: string }[]
    const capaOrder = orders.find((order) => order.requester_name === 'CAPA Requester')!
    const facilities = await signIn('facilities')
    const blocked = await call('/transition', { token: facilities, body: { orderId: capaOrder.id, targetStatus: 'approved', note: 'Approved' } })
    expect(blocked.status).toBe(400)
    expect((await call('/transition', { token: await signIn('capa'), body: { orderId: capaOrder.id, targetStatus: 'approved', note: 'Approved' } })).status).toBe(200)
  })

  it('looks up status only, by request code', async () => {
    const { body } = await call('/lookup', { body: { requestCode: 'aaaa-aaaa' } })
    expect(body).toMatchObject({ found: true, status: 'submitted' })
    expect(Object.keys(body).sort()).toEqual(['found', 'status', 'submittedAt', 'updatedAt'])
    expect((await call('/lookup', { body: { requestCode: 'ZZZZ-ZZZZ' } })).body.found).toBe(false)
  })

  it('lets only the super-admin add departments', async () => {
    const department = { name: 'Kitchen', code: 'KIT' }
    expect((await call('/departments', { token: await signIn('capa'), body: department })).status).toBe(403)
    expect((await call('/departments', { token: await signIn('admin'), body: department })).status).toBe(201)
    expect((await call('/departments', { token: await signIn('admin'), body: department })).status).toBe(409)
  })
})
