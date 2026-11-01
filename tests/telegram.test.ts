import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApi, type Database } from '../functions/handler'
import { hashPassword } from '../functions/password'

// The real handler and migrations, with a stand-in for Telegram's servers.
const origin = 'https://shailp08.github.io'
const secret = 'webhook-secret'
const migrations = new URL('../db/migrations/', import.meta.url)
const facilitiesChat = 1001
const capaChat = 1002
const adminChat = 1003
const requesterChat = 2001

let db: PGlite
let api: (request: Request) => Promise<Response>
let departments: Record<string, string>
let sent: { method: string; payload: Record<string, any> }[]
let failSending = false
let nextMessageId = 1
let background: Promise<unknown>[] = []

const telegramFetch = (async (url: string, init: RequestInit) => {
  if (failSending) return Response.json({ ok: false, error_code: 502 })
  sent.push({ method: String(url).split('/').pop()!, payload: JSON.parse(String(init.body)) })
  return Response.json({ ok: true, result: { message_id: nextMessageId++ } })
}) as typeof fetch

const settle = async () => {
  await Promise.all(background)
  background = []
}

const call = async (path: string, options: { body?: unknown; token?: string } = {}) => {
  const headers: Record<string, string> = { origin, 'x-forwarded-for': '203.0.113.9' }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await api(new Request(`https://api.test${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }))
  await settle()
  return { status: response.status, body: await response.json() as Record<string, any> }
}

const webhook = async (update: Record<string, unknown>, token: string | null = secret) => {
  const headers: Record<string, string> = {}
  if (token) headers['x-telegram-bot-api-secret-token'] = token
  const { status } = await api(new Request('https://api.test/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update) }))
  return status
}

const say = (chatId: number, text: string) => webhook({ message: { text, chat: { id: chatId, type: 'private' }, from: { id: chatId } } })
const tap = (chatId: number, data: string, messageId = 1) => webhook({
  callback_query: { id: 'tap', data, from: { id: chatId }, message: { message_id: messageId, chat: { id: chatId, type: 'private' } } },
})

const signIn = async (username: string) =>
  (await call('/login', { body: { username, password: `${username}-password` } })).body.token as string

const connect = async (username: string, chatId: number) => {
  const { body } = await call('/telegram/link', { token: await signIn(username), body: {} })
  await say(chatId, `/start ${String(body.url).split('start=')[1]}`)
}

let codeCounter = 0
const makeCode = () => {
  codeCounter += 1
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  return `TEST-${letters[Math.floor(codeCounter / 23)]}${letters[codeCounter % 23]}AA`
}

const submit = async (departmentId: string, requestCode = makeCode(), idempotencyKey = randomUUID()) => {
  await call('/submit', {
    body: {
      requestCode,
      idempotencyKey,
      request: {
        requesterName: 'Alex <b>Morgan</b>', departmentId, vendorName: 'Vendor', vendorUrl: '', costCenter: 'Hall',
        businessReason: 'Restocking supplies for the hall.', currency: 'USD', website: '',
        items: [{ description: 'Paper', quantity: 2, unitPrice: 12.5 }],
      },
    },
  })
  const { rows } = await db.query<{ id: string; reference: string }>('select id, reference from public.purchase_orders order by created_at desc, reference desc limit 1')
  return { ...rows[0]!, requestCode, idempotencyKey }
}

const messagesTo = (chatId: number) => sent.filter(({ payload }) => payload.chat_id === chatId)
const statusOf = async (id: string) => (await db.query<{ status: string }>('select status from public.purchase_orders where id = $1', [id])).rows[0]!.status

beforeAll(async () => {
  db = new PGlite()
  for (const name of (await readdir(migrations)).sort()) await db.exec(await readFile(new URL(name, migrations), 'utf8'))
  await db.exec(await readFile(new URL('../db/delmandir.sql', import.meta.url), 'utf8'))
  const rows = (await db.query<{ id: string; code: string }>('select id, code from public.departments')).rows
  departments = Object.fromEntries(rows.map(({ id, code }) => [code, id]))
  for (const [username, code] of [['admin', null], ['facilities', 'FAC'], ['capa', 'CAPA']] as const) {
    const hash = await hashPassword(`${username}-password`)
    const user = await db.query<{ id: string }>('insert into auth.users (username, password_hash) values ($1, $2) returning id', [username, hash])
    await db.query(
      `insert into public.profiles (user_id, full_name, role, department_id) values ($1, $2, $3::public.admin_role, $4)`,
      [user.rows[0]!.id, `${username} lead`, code ? 'department_admin' : 'global_admin', code ? departments[code] : null],
    )
  }
  const database: Database = {
    transaction: (run) => db.transaction((tx) => run((sql, params) => tx.query(sql, params))) as never,
  }
  api = createApi({
    database,
    allowedOrigins: [origin],
    authSecret: 'test-secret-test-secret-test-secret',
    rateLimitSalt: 'salt',
    telegram: { token: 'bot-token', webhookSecret: secret, username: 'podesk_bot', fetchImpl: telegramFetch },
    runInBackground: (work) => { background.push(work) },
  })
  sent = []
  await connect('facilities', facilitiesChat)
  await connect('capa', capaChat)
  await connect('admin', adminChat)
}, 30000)

beforeEach(() => { sent = []; failSending = false })

afterAll(async () => { await db.close() })

describe('Telegram bot', () => {
  it('ignores webhook calls without the secret', async () => {
    expect(await webhook({ message: {} }, 'wrong')).toBe(404)
    expect(await webhook({ message: {} }, null)).toBe(404)
    expect(sent).toHaveLength(0)
  })

  it('ignores group chats', async () => {
    await webhook({ message: { text: '/pending', chat: { id: -5, type: 'group' }, from: { id: facilitiesChat } } })
    expect(sent).toHaveLength(0)
  })

  it('uses a connection link once and refuses a bad one', async () => {
    const { body } = await call('/telegram/link', { token: await signIn('capa'), body: {} })
    const code = String(body.url).split('start=')[1]
    expect(body.url).toContain('https://t.me/podesk_bot?start=')
    await say(3001, `/start ${code}`)
    expect(messagesTo(3001).at(-1)!.payload.text).toContain('Connected as capa lead')
    await say(3002, `/start ${code}`)
    expect(messagesTo(3002).at(-1)!.payload.text).toContain('expired')
    expect((await db.query('select 1 from public.telegram_admins where telegram_user_id = 3002')).rows).toHaveLength(0)
    await db.query('delete from public.telegram_admins where telegram_user_id = 3001')
  })

  it('needs a signed-in admin to create a connection link', async () => {
    expect((await call('/telegram/link', { body: {} })).status).toBe(401)
  })

  it('sends a new request to its department only', async () => {
    const order = await submit(departments.FAC!)
    expect(messagesTo(facilitiesChat)).toHaveLength(1)
    expect(messagesTo(adminChat)).toHaveLength(0)
    expect(messagesTo(capaChat)).toHaveLength(0)
    const { payload } = messagesTo(facilitiesChat)[0]!
    expect(payload.text).toContain(order.reference)
    expect(payload.text).toContain('Total: $25.00')
    expect(payload).not.toHaveProperty('parse_mode')
    expect(payload.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text)).toEqual(['Accept', 'Deny'])
  })

  it('does not alert twice when a submission is retried', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await submit(departments.FAC!, order.requestCode, order.idempotencyKey)
    expect(sent).toHaveLength(0)
  })

  it('still saves a request when Telegram is down, and /pending catches up', async () => {
    failSending = true
    const order = await submit(departments.CAPA!)
    failSending = false
    expect(await statusOf(order.id)).toBe('submitted')
    await say(capaChat, '/pending')
    expect(messagesTo(capaChat).some(({ payload }) => payload.text?.includes(order.reference))).toBe(true)
  })

  it('requires a reason before accepting', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    expect(await statusOf(order.id)).toBe('submitted')
    expect(messagesTo(facilitiesChat).at(-1)!.payload.text).toContain(`Why are you accepting ${order.reference}?`)
    await say(facilitiesChat, 'ok')
    expect(await statusOf(order.id)).toBe('submitted')
    await say(facilitiesChat, 'Within this month budget')
    expect(await statusOf(order.id)).toBe('approved')
    const audit = await db.query<{ actor_name: string; note: string }>(
      `select actor_name, note from public.audit_events where purchase_order_id = $1 and action = 'status_changed'`, [order.id],
    )
    expect(audit.rows).toEqual([{ actor_name: 'facilities lead', note: 'Within this month budget' }])
  })

  it('tells the super-admin once a department admin approves, without buttons', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    await say(facilitiesChat, 'Within this month budget')
    const alerts = messagesTo(adminChat)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.payload.text).toContain(`${order.reference}: Approved`)
    expect(alerts[0]!.payload.text).toContain('Reason: Within this month budget')
    expect(alerts[0]!.payload.text).toContain('Total: $25.00')
    expect(alerts[0]!.payload.reply_markup.inline_keyboard).toEqual([])
  })

  it('tells the super-admin about approvals made on the website', async () => {
    const order = await submit(departments.FAC!)
    await call('/transition', { token: await signIn('facilities'), body: { orderId: order.id, targetStatus: 'approved', note: 'Approved' } })
    expect(messagesTo(adminChat).at(-1)!.payload.text).toContain(`${order.reference}: Approved`)
  })

  it('does not tell the super-admin about denials', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:rejected:${order.id}`)
    await say(facilitiesChat, 'Over the yearly budget')
    expect(await statusOf(order.id)).toBe('rejected')
    expect(messagesTo(adminChat)).toHaveLength(0)
  })

  it('still lists denied requests for the super-admin on the site', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:rejected:${order.id}`)
    await say(facilitiesChat, 'Over the yearly budget')
    const { body } = await call('/orders', { token: await signIn('admin') })
    expect(body.orders.find((row: { id: string }) => row.id === order.id).status).toBe('rejected')
  })

  it('requires a reason before denying, and removes the buttons', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:rejected:${order.id}`)
    await say(facilitiesChat, 'Over the yearly budget')
    expect(await statusOf(order.id)).toBe('rejected')
    const edits = sent.filter(({ method }) => method === 'editMessageText')
    expect(edits.map(({ payload }) => payload.chat_id)).toEqual([facilitiesChat])
    for (const { payload } of edits) {
      expect(payload.text).toContain('Denied')
      expect(payload.text).toContain('Reason: Over the yearly budget')
      expect(payload.reply_markup.inline_keyboard).toEqual([])
    }
  })

  it('leaves the request unchanged on /cancel', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    await say(facilitiesChat, '/cancel')
    await say(facilitiesChat, 'This text is not a reason now')
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('lets a reason lapse', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    await db.query(`update public.telegram_admins set pending_until = now() - interval '1 minute'`)
    await say(facilitiesChat, 'This reason arrives too late')
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('stops an admin from deciding for another department', async () => {
    const order = await submit(departments.CAPA!)
    sent = []
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    expect(sent.find(({ method }) => method === 'answerCallbackQuery')!.payload.text).toContain('cannot decide')
    await say(facilitiesChat, 'Trying to approve anyway')
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('stops a stranger from deciding', async () => {
    const order = await submit(departments.FAC!)
    await tap(9999, `decide:approved:${order.id}`)
    await say(9999, 'Approve this please')
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('keeps the first decision when two admins answer at once', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    await tap(adminChat, `decide:rejected:${order.id}`)
    await say(facilitiesChat, 'Approved for the event')
    await say(adminChat, 'Denied by the super-admin')
    expect(await statusOf(order.id)).toBe('approved')
    expect(messagesTo(adminChat).at(-1)!.payload.text).toContain('already decided')
  })

  it('tracks a request by code and sends the reason to the requester', async () => {
    const order = await submit(departments.FAC!)
    await say(requesterChat, order.requestCode.toLowerCase())
    const first = messagesTo(requesterChat).at(-1)!.payload.text as string
    expect(first).toContain(`Request ${order.reference}: New`)
    expect(first).not.toContain('Alex')
    expect(first).not.toContain('Vendor')
    await tap(facilitiesChat, `decide:rejected:${order.id}`)
    await say(facilitiesChat, 'Please use the existing stock')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toBe(`Request ${order.reference}: Denied\nReason: Please use the existing stock`)
    await say(requesterChat, '/status')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toContain(`${order.reference}: Denied`)
    await say(requesterChat, '/stop')
    await say(requesterChat, '/status')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toContain('not tracking')
  })

  it('tells trackers about changes made on the website', async () => {
    const order = await submit(departments.CAPA!)
    await say(requesterChat, `/start ${order.requestCode}`)
    sent = []
    await call('/transition', { token: await signIn('capa'), body: { orderId: order.id, targetStatus: 'under_review', note: '' } })
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toBe(`Request ${order.reference}: Under review`)
    await say(requesterChat, '/stop')
  })

  it('limits guessed request codes', async () => {
    for (let attempt = 0; attempt < 21; attempt += 1) await say(4001, 'ZZZZ-ZZZZ')
    expect(messagesTo(4001).at(-1)!.payload.text).toContain('Too many tries')
  })

  it('disconnects Telegram when the password changes', async () => {
    const token = await signIn('capa')
    await call('/password', { token, body: { currentPassword: 'capa-password', newPassword: 'a-long-new-password' } })
    expect((await db.query('select 1 from public.telegram_admins where telegram_user_id = $1', [capaChat])).rows).toHaveLength(0)
  })

  it('stays off without a bot configured', async () => {
    const plain = createApi({
      database: { transaction: () => Promise.reject(new Error('unused')) },
      allowedOrigins: [origin],
      authSecret: 'test-secret-test-secret-test-secret',
      rateLimitSalt: 'salt',
    })
    const response = await plain(new Request('https://api.test/telegram/webhook', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(404)
  })
})
