import { createHash } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import { createBot, verifyWebhookSecret, type BotConfig } from './bot.ts'
import { decoyHash, hashPassword, verifyPassword } from './password.ts'
import { requestCodePattern, validatePurchaseOrderRequest } from './validation.ts'

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>

export interface Database {
  transaction<T>(run: (query: Query) => Promise<T>): Promise<T>
}

export interface ApiConfig {
  database: Database
  allowedOrigins: string[]
  authSecret: string
  rateLimitSalt: string
  turnstileSecret?: string
  telegram?: BotConfig
  runInBackground?: (work: Promise<unknown>) => void
}

type DatabaseRole = 'anon' | 'authenticated' | 'service_role'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const invalidInputCodes = ['P0001', '22P02', '22007', '22003', '23514', '23502']
const sessionLength = '8h'
const minPasswordLength = 12
const maxPasswordLength = 200

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const verifyTurnstile = async (secret: string, token: string, remoteIp: string) => {
  if (!token) return false
  const form = new FormData()
  form.set('secret', secret)
  form.set('response', token)
  form.set('remoteip', remoteIp)
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  const result = (await response.json()) as { success?: boolean }
  return result.success === true
}

export const createApi = ({
  database, allowedOrigins, authSecret, rateLimitSalt, turnstileSecret, telegram, runInBackground = () => undefined,
}: ApiConfig) => {
  const key = new TextEncoder().encode(authSecret)

  const asRole = <T>(role: DatabaseRole, userId: string, run: (query: Query) => Promise<T>) =>
    database.transaction(async (query) => {
      await query(`set local role ${role}`)
      await query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId])
      return run(query)
    })

  const clientIp = (request: Request) => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const claimLimit = async (bucket: string, identity: string, limit: number) => {
    const fingerprint = sha256(`${identity}:${bucket}:${rateLimitSalt}`)
    const { rows } = await asRole('service_role', '', (query) =>
      query('select public.claim_rate_limit($1, $2, $3) as allowed', [bucket, fingerprint, limit]))
    if (!rows[0]?.allowed) throw new ApiError(429, 'Too many attempts. Try again later.')
  }

  const bot = telegram ? createBot(telegram, { asRole, claimLimit }) : null

  const notify = (work: Promise<unknown>) => {
    runInBackground(work.catch((error) => console.error('telegram notification failed', (error as Error).message)))
  }

  const readBody = async (request: Request, maxLength: number) => {
    const rawBody = await request.text()
    if (rawBody.length > maxLength) throw new ApiError(413, 'Request is too large.')
    let body: unknown
    try { body = JSON.parse(rawBody) } catch { throw new ApiError(400, 'Invalid request body.') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Invalid request body.')
    return body as Record<string, unknown>
  }

  const requireUser = async (request: Request) => {
    const header = request.headers.get('authorization') ?? ''
    if (!header.toLowerCase().startsWith('bearer ')) throw new ApiError(401, 'Sign in to continue.')
    const ended = new ApiError(401, 'Your session has ended. Sign in again.')
    let userId: string
    let issuedAt: number
    try {
      const { payload } = await jwtVerify(header.slice(7), key, { algorithms: ['HS256'] })
      if (!payload.sub || !uuidPattern.test(payload.sub) || !payload.iat) throw new Error('Missing claims')
      userId = payload.sub
      issuedAt = payload.iat
    } catch {
      throw ended
    }
    const { rows } = await asRole('service_role', '', (query) => query(
      'select floor(extract(epoch from password_changed_at))::bigint as changed_at from auth.users where id = $1',
      [userId],
    ))
    if (!rows[0] || issuedAt < Number(rows[0].changed_at)) throw ended
    return userId
  }

  const issueToken = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId).setIssuedAt().setExpirationTime(sessionLength).sign(key)

  const readProfile = async (userId: string) => {
    const { rows } = await asRole('authenticated', userId, (query) => query(
      `select p.user_id, p.full_name, p.role, p.department_id, json_build_object('name', d.name) as departments
       from public.profiles p
       left join public.departments d on d.id = p.department_id
       where p.user_id = $1`,
      [userId],
    ))
    return rows[0] ?? null
  }

  const routes: Record<string, (request: Request) => Promise<{ status?: number; body: unknown }>> = {
    'GET /departments': async () => {
      const { rows } = await asRole('anon', '', (query) => query(
        'select id, name, code, active from public.departments where active order by name',
      ))
      return { body: { departments: rows } }
    },

    'POST /submit': async (request) => {
      const body = await readBody(request, 100_000)
      const payload = body.request && typeof body.request === 'object' && !Array.isArray(body.request)
        ? body.request as Record<string, unknown>
        : {}
      const validationError = validatePurchaseOrderRequest(payload)
      if (validationError) throw new ApiError(400, validationError)
      const requestCode = text(body.requestCode).toUpperCase()
      const idempotencyKey = text(body.idempotencyKey)
      if (!requestCodePattern.test(requestCode) || !uuidPattern.test(idempotencyKey)) {
        throw new ApiError(400, 'Invalid submission identity.')
      }
      if (turnstileSecret && !(await verifyTurnstile(turnstileSecret, text(body.turnstileToken), clientIp(request)))) {
        throw new ApiError(400, 'Spam-prevention check failed.')
      }
      await claimLimit('submit-po', clientIp(request), 30)
      try {
        const { rows } = await asRole('service_role', '', (query) => query(
          'select * from public.submit_purchase_order_service($1::jsonb, $2, $3::uuid)',
          [JSON.stringify(payload), requestCode, idempotencyKey],
        ))
        if (!rows[0]?.submitted_at) throw new Error('Missing submission receipt')
        if (bot) notify(bot.notifyNewOrder(rows[0].reference))
        return { status: 201, body: { submittedAt: rows[0].submitted_at } }
      } catch (error) {
        if (invalidInputCodes.includes((error as { code?: string }).code ?? '')) {
          throw new ApiError(400, 'The request was not saved. Check the department and item details before trying again.')
        }
        throw error
      }
    },

    'POST /lookup': async (request) => {
      const body = await readBody(request, 1000)
      const requestCode = text(body.requestCode).toUpperCase()
      if (!requestCodePattern.test(requestCode)) return { body: { found: false } }
      await claimLimit('lookup-po', clientIp(request), 60)
      const { rows } = await asRole('service_role', '', (query) => query(
        'select status, created_at, updated_at from public.purchase_orders where request_code_hash = $1',
        [sha256(requestCode)],
      ))
      const order = rows[0]
      if (!order) return { body: { found: false } }
      return { body: { found: true, status: order.status, submittedAt: order.created_at, updatedAt: order.updated_at } }
    },

    'POST /login': async (request) => {
      const body = await readBody(request, 1000)
      const username = text(body.username).toLowerCase()
      const password = typeof body.password === 'string' ? body.password.slice(0, 200) : ''
      await claimLimit('login-ip', clientIp(request), 30)
      await claimLimit('login-user', username, 15)
      const { rows } = await asRole('service_role', '', (query) => query(
        'select id, password_hash from auth.users where username = $1',
        [username],
      ))
      const user = rows[0]
      const matches = await verifyPassword(password, user?.password_hash ?? decoyHash)
      if (!user || !matches) throw new ApiError(401, 'Incorrect username or password.')
      const profile = await readProfile(user.id)
      if (!profile) throw new ApiError(403, 'This account does not have PO Desk access.')
      return { body: { token: await issueToken(user.id), profile } }
    },

    'POST /password': async (request) => {
      const userId = await requireUser(request)
      const body = await readBody(request, 1000)
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
      await claimLimit('password-change', userId, 10)
      const { rows } = await asRole('service_role', '', (query) => query(
        'select password_hash from auth.users where id = $1',
        [userId],
      ))
      if (!rows[0] || !(await verifyPassword(currentPassword.slice(0, maxPasswordLength), rows[0].password_hash))) {
        throw new ApiError(400, 'Your current password is incorrect.')
      }
      if (newPassword.length < minPasswordLength || newPassword.length > maxPasswordLength) {
        throw new ApiError(400, `Use at least ${minPasswordLength} characters for your new password.`)
      }
      if (newPassword === currentPassword) throw new ApiError(400, 'Choose a different password.')
      const hash = await hashPassword(newPassword)
      await asRole('service_role', '', (query) => query(
        'update auth.users set password_hash = $1, password_changed_at = now() where id = $2',
        [hash, userId],
      ))
      return { body: { token: await issueToken(userId) } }
    },

    'GET /me': async (request) => {
      const profile = await readProfile(await requireUser(request))
      if (!profile) throw new ApiError(401, 'Your session has ended. Sign in again.')
      return { body: { profile } }
    },

    'GET /orders': async (request) => {
      const userId = await requireUser(request)
      const { rows } = await asRole('authenticated', userId, (query) => query(
        `select po.id, po.reference, po.department_id, po.requester_name, po.vendor_name, po.vendor_url,
           po.cost_center, po.business_reason, po.currency, po.subtotal, po.total, po.status,
           po.created_at, po.updated_at,
           json_build_object('name', d.name, 'code', d.code) as departments,
           coalesce((select json_agg(i) from public.purchase_order_items i where i.purchase_order_id = po.id), '[]') as purchase_order_items,
           coalesce((select json_agg(a) from public.audit_events a where a.purchase_order_id = po.id), '[]') as audit_events
         from public.purchase_orders po
         left join public.departments d on d.id = po.department_id
         order by po.created_at desc, po.id desc`,
      ))
      return { body: { orders: rows } }
    },

    'POST /transition': async (request) => {
      const userId = await requireUser(request)
      const body = await readBody(request, 5000)
      try {
        await asRole('authenticated', userId, (query) => query(
          'select public.transition_purchase_order($1::uuid, $2::public.order_status, $3)',
          [text(body.orderId), text(body.targetStatus), text(body.note)],
        ))
      } catch (error) {
        const { code, message } = error as { code?: string; message?: string }
        if (code === 'P0001') throw new ApiError(400, message ?? 'That status change is not allowed.')
        if (code === '22P02') throw new ApiError(400, 'That status change is not allowed.')
        throw error
      }
      if (bot) notify(bot.notifyStatusChange(text(body.orderId)))
      return { body: { ok: true } }
    },

    'POST /telegram/link': async (request) => {
      if (!bot) throw new ApiError(404, 'Not found.')
      const userId = await requireUser(request)
      await claimLimit('telegram-link', userId, 10)
      return { body: { url: await bot.issueAdminLink(userId) } }
    },

    'POST /departments': async (request) => {
      const userId = await requireUser(request)
      const body = await readBody(request, 1000)
      try {
        const { rows } = await asRole('authenticated', userId, (query) => query(
          'insert into public.departments (name, code) values ($1, $2) returning id, name, code, active',
          [text(body.name), text(body.code).toUpperCase()],
        ))
        return { status: 201, body: { department: rows[0] } }
      } catch (error) {
        const { code } = error as { code?: string }
        if (code === '23505') throw new ApiError(409, 'That department name or code is already in use.')
        if (code === '42501') throw new ApiError(403, 'Only the global administrator can add departments.')
        if (code === '23514' || code === '23502') throw new ApiError(400, 'Check the department name and code.')
        throw error
      }
    },
  }

  // Telegram calls this directly, so it proves itself with a secret instead of an Origin.
  const handleWebhook = async (request: Request) => {
    if (!bot || !verifyWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'), telegram!.webhookSecret)) {
      return new Response(null, { status: 404 })
    }
    try {
      await bot.handleUpdate(await readBody(request, 100_000))
    } catch (error) {
      // Answering with an error makes Telegram resend the same update.
      console.error('telegram webhook failed', (error as Error).message)
    }
    return new Response(null, { status: 200 })
  }

  return async (request: Request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/telegram/webhook') return handleWebhook(request)
    const origin = request.headers.get('origin')
    const allowed = Boolean(origin && allowedOrigins.includes(origin))
    const headers = {
      'Access-Control-Allow-Origin': allowed ? origin! : allowedOrigins[0] ?? '',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (!allowed) return json({ error: 'Origin not allowed.' }, 403)
    const route = routes[`${request.method} ${new URL(request.url).pathname}`]
    if (!route) return json({ error: 'Not found.' }, 404)
    try {
      const { status = 200, body } = await route(request)
      return json(body, status)
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status)
      console.error('api request failed', (error as { code?: string }).code ?? '')
      return json({ error: 'The service could not complete this request.' }, 500)
    }
  }
}
