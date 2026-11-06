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
const group = -100500
const strangerChat = 9999

let db: PGlite
let api: (request: Request) => Promise<Response>
let departments: Record<string, string>
let sent: { method: string; payload: Record<string, any> }[]
let failSending = false
let nextMessageId = 1
let background: Promise<unknown>[] = []

const telegramFetch = (async (url: string, init: RequestInit) => {
  if (failSending) return Response.json({ ok: false, error_code: 502 })
  const entry = { method: String(url).split('/').pop()!, payload: JSON.parse(String(init.body)) }
  sent.push(entry)
  sentIds.set(entry, nextMessageId)
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

let groupMessageId = 5000
const post = (fromId: number, text: string, replyTo?: number, chatId = group) => webhook({
  message: {
    message_id: groupMessageId++, text, chat: { id: chatId, type: 'supergroup' }, from: { id: fromId, first_name: `User${fromId}` },
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  },
})
const tap = (fromId: number, data: string, chatId = group) => webhook({
  callback_query: { id: 'tap', data, from: { id: fromId, first_name: `User${fromId}` }, message: { message_id: 1, chat: { id: chatId, type: chatId === fromId ? 'private' : 'supergroup' } } },
})
const lastPrompt = () => [...sent].reverse().find(({ payload }) => String(payload.text ?? '').includes('Reply to this message'))!
// Tap a button, then reply to the bot's question with a reason.
const decide = async (fromId: number, status: 'approved' | 'rejected', orderId: string, reason: string) => {
  sent = []
  await tap(fromId, `decide:${status}:${orderId}`)
  const prompt = lastPrompt()
  await post(fromId, reason, prompt ? sentIds.get(prompt)! : undefined)
}
const sentIds = new Map<object, number>()

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
  await post(facilitiesChat, '/connect')
}, 30000)

beforeEach(() => { sent = []; failSending = false })

afterAll(async () => { await db.close() })

describe('Telegram bot', () => {
  it('ignores webhook calls without the secret', async () => {
    expect(await webhook({ message: {} }, 'wrong')).toBe(404)
    expect(await webhook({ message: {} }, null)).toBe(404)
    expect(sent).toHaveLength(0)
  })

  it('lets only a connected admin choose the group', async () => {
    await post(strangerChat, '/connect', undefined, -777)
    expect(messagesTo(-777).at(-1)!.payload.text).toContain('Only a connected PO Desk admin')
    expect((await db.query('select chat_id from public.telegram_group')).rows).toEqual([{ chat_id: group }])
  })

  it('ignores other groups', async () => {
    await post(facilitiesChat, '/pending', undefined, -888)
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

  it('posts every new request once, in the group only', async () => {
    const order = await submit(departments.CAPA!)
    expect(sent).toHaveLength(1)
    const { payload } = messagesTo(group)[0]!
    expect(payload.text).toContain(order.reference)
    expect(payload.text).toContain('Department: CAPA')
    expect(payload.text).toContain('Total: $25.00')
    expect(payload).not.toHaveProperty('parse_mode')
    expect(payload.reply_markup.inline_keyboard[0].map((button: { text: string }) => button.text)).toEqual(['Accept', 'Deny'])
  })

  it('does not post twice when a submission is retried', async () => {
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
    await post(capaChat, '/pending')
    expect(messagesTo(group).some(({ payload }) => payload.text?.includes(order.reference))).toBe(true)
  })

  it('asks the admin who tapped for a reason, by name', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    expect(await statusOf(order.id)).toBe('submitted')
    const { payload } = lastPrompt()
    expect(payload.chat_id).toBe(group)
    expect(payload.text).toContain(`why are you accepting ${order.reference}?`)
    expect(payload.entities[0]).toMatchObject({ type: 'text_mention', user: { id: facilitiesChat } })
    expect(payload.reply_markup).toMatchObject({ force_reply: true, selective: true })
  })

  it('requires a reason before accepting', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    const promptId = sentIds.get(lastPrompt())!
    await post(facilitiesChat, 'ok', promptId)
    expect(await statusOf(order.id)).toBe('submitted')
    await post(facilitiesChat, 'Within this month budget', promptId)
    expect(await statusOf(order.id)).toBe('approved')
    const audit = await db.query<{ actor_name: string; note: string }>(
      `select actor_name, note from public.audit_events where purchase_order_id = $1 and action = 'status_changed'`, [order.id],
    )
    expect(audit.rows).toEqual([{ actor_name: 'facilities lead', note: 'Within this month budget' }])
    expect(messagesTo(group).at(-1)!.payload.text).toBe('Saved: Approved by facilities lead.')
  })

  it('only counts a reply to the question as the reason', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    await post(facilitiesChat, 'Chatting about something else in the group')
    await post(facilitiesChat, 'Replying to some other message', 12345)
    expect(await statusOf(order.id)).toBe('submitted')
    await post(facilitiesChat, '/cancel')
  })

  it('does not take a reason from someone else in the group', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    const promptId = sentIds.get(lastPrompt())!
    await post(capaChat, 'Approving this for Facilities', promptId)
    await post(strangerChat, 'Approving this for Facilities', promptId)
    expect(await statusOf(order.id)).toBe('submitted')
    await post(facilitiesChat, '/cancel')
  })

  it('denies with a reason and removes the buttons', async () => {
    const order = await submit(departments.FAC!)
    await decide(facilitiesChat, 'rejected', order.id, 'Over the yearly budget')
    expect(await statusOf(order.id)).toBe('rejected')
    const edits = sent.filter(({ method }) => method === 'editMessageText')
    expect(edits.map(({ payload }) => payload.chat_id)).toEqual([group])
    expect(edits[0]!.payload.text).toContain('Denied')
    expect(edits[0]!.payload.text).toContain('Reason: Over the yearly budget')
    expect(edits[0]!.payload.reply_markup.inline_keyboard).toEqual([])
  })

  it('leaves the request unchanged on /cancel', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    const promptId = sentIds.get(lastPrompt())!
    await post(facilitiesChat, '/cancel')
    await post(facilitiesChat, 'This text is not a reason now', promptId)
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('lets a reason lapse', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    const promptId = sentIds.get(lastPrompt())!
    await db.query(`update public.telegram_admins set pending_until = now() - interval '1 minute'`)
    await post(facilitiesChat, 'This reason arrives too late', promptId)
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('stops an admin from deciding for another department', async () => {
    const order = await submit(departments.CAPA!)
    sent = []
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    expect(sent.find(({ method }) => method === 'answerCallbackQuery')!.payload.text).toBe('Only the CAPA admin can decide this request.')
    expect(lastPrompt()).toBeUndefined()
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('stops a group member without a PO Desk login from deciding', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await tap(strangerChat, `decide:approved:${order.id}`)
    expect(sent.find(({ method }) => method === 'answerCallbackQuery')!.payload.text).toContain('Only PO Desk admins')
    expect(await statusOf(order.id)).toBe('submitted')
  })

  it('lets the super-admin decide any department', async () => {
    const order = await submit(departments.CAPA!)
    await decide(adminChat, 'approved', order.id, 'Approved by the super-admin')
    expect(await statusOf(order.id)).toBe('approved')
  })

  it('keeps the first decision when two admins answer at once', async () => {
    const order = await submit(departments.FAC!)
    await tap(facilitiesChat, `decide:approved:${order.id}`)
    const first = sentIds.get(lastPrompt())!
    await tap(adminChat, `decide:rejected:${order.id}`)
    const second = sentIds.get(lastPrompt())!
    await post(facilitiesChat, 'Approved for the event', first)
    await post(adminChat, 'Denied by the super-admin', second)
    expect(await statusOf(order.id)).toBe('approved')
    expect(messagesTo(group).at(-1)!.payload.text).toContain('already decided')
  })

  it('tracks a request by code in a private chat and sends the reason', async () => {
    const order = await submit(departments.FAC!)
    await say(requesterChat, order.requestCode.toLowerCase())
    const first = messagesTo(requesterChat).at(-1)!.payload.text as string
    expect(first).toContain(`Request ${order.reference}: New`)
    expect(first).not.toContain('Alex')
    expect(first).not.toContain('Vendor')
    await decide(facilitiesChat, 'rejected', order.id, 'Please use the existing stock')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toBe(`Request ${order.reference}: Denied\nReason: Please use the existing stock`)
    await say(requesterChat, '/status')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toContain(`${order.reference}: Denied`)
    await say(requesterChat, '/stop')
    await say(requesterChat, '/status')
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toContain('not tracking')
  })

  it('never looks up a request code posted in the group', async () => {
    const order = await submit(departments.FAC!)
    sent = []
    await post(strangerChat, order.requestCode)
    expect(sent).toHaveLength(0)
  })

  it('tells trackers about changes made on the website', async () => {
    const order = await submit(departments.CAPA!)
    await say(requesterChat, `/start ${order.requestCode}`)
    sent = []
    await call('/transition', { token: await signIn('capa'), body: { orderId: order.id, targetStatus: 'under_review', note: '' } })
    expect(messagesTo(requesterChat).at(-1)!.payload.text).toBe(`Request ${order.reference}: Under review`)
    expect(messagesTo(group).at(-1)!.payload.text).toContain('Under review')
    await say(requesterChat, '/stop')
  })

  it('follows the group when Telegram upgrades it', async () => {
    await webhook({ message: { message_id: 1, chat: { id: group, type: 'group' }, from: { id: facilitiesChat }, migrate_to_chat_id: -100777 } })
    expect((await db.query('select chat_id from public.telegram_group')).rows).toEqual([{ chat_id: -100777 }])
    await db.query('update public.telegram_group set chat_id = $1', [group])
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
