import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Query } from './handler.ts'
import { requestCodePattern } from './validation.ts'

type Role = 'authenticated' | 'service_role'
type AsRole = <T>(role: Role, userId: string, run: (query: Query) => Promise<T>) => Promise<T>
type Send = (method: string, payload: Record<string, unknown>) => Promise<Record<string, any>>

export interface BotConfig {
  token: string
  webhookSecret: string
  username: string
  fetchImpl?: typeof fetch
}

interface BotContext {
  asRole: AsRole
  claimLimit: (bucket: string, identity: string, limit: number) => Promise<void>
}

const maxMessageLength = 4000
const minReasonLength = 5
const maxReasonLength = 1000
const reasonWindowMinutes = 30
const adminLinkMinutes = 15
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const decisionPattern = new RegExp(`^decide:(approved|rejected):(${uuid})$`, 'i')
const openStatuses = ['submitted', 'under_review', 'needs_information']
const statusLabels: Record<string, string> = {
  submitted: 'New',
  under_review: 'Under review',
  needs_information: 'Needs information',
  approved: 'Approved',
  rejected: 'Denied',
  ordered: 'Ordered',
}
// The reason is shown to the requester only for these statuses.
const requesterNoteStatuses = ['needs_information', 'approved', 'rejected']

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const money = (value: unknown) => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const shorten = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value)
const quantity = (value: unknown) => String(Number(value))

const orderSelect = `select po.id, po.reference, po.requester_name, po.vendor_name, po.vendor_url, po.cost_center,
    po.business_reason, po.total, po.status, po.department_id, d.name as department,
    coalesce((select json_agg(json_build_object('description', i.description, 'quantity', i.quantity, 'unitPrice', i.unit_price) order by i.position)
      from public.purchase_order_items i where i.purchase_order_id = po.id), '[]') as items,
    (select json_build_object('actor', a.actor_name, 'note', a.note) from public.audit_events a
      where a.purchase_order_id = po.id and a.action = 'status_changed'
      order by a.created_at desc limit 1) as decision
  from public.purchase_orders po
  join public.departments d on d.id = po.department_id`

// Plain text only, so nothing a requester typed can act as Telegram formatting.
const alertText = (order: Record<string, any>) => {
  const lines = [
    `${order.reference}: ${statusLabels[order.status] ?? order.status}`,
    order.decision?.actor ? `By: ${order.decision.actor}` : '',
    order.decision?.note ? `Reason: ${order.decision.note}` : '',
    '',
    `Department: ${order.department}`,
    `From: ${order.requester_name}`,
    `Store: ${order.vendor_name}`,
    order.cost_center ? `Project: ${order.cost_center}` : '',
    order.vendor_url ? `Link: ${order.vendor_url}` : '',
    `Purpose: ${shorten(order.business_reason, 800)}`,
    `Total: ${money(order.total)}`,
    '',
    ...order.items.map((item: Record<string, unknown>) =>
      `${quantity(item.quantity)} x ${shorten(String(item.description), 80)} at ${money(item.unitPrice)}`),
  ]
  return shorten(lines.filter((line, index) => line || !lines[index - 1]).join('\n'), maxMessageLength)
}

const alertKeyboard = (order: Record<string, any>) => ({
  inline_keyboard: openStatuses.includes(order.status)
    ? [[
        { text: 'Accept', callback_data: `decide:approved:${order.id}` },
        { text: 'Deny', callback_data: `decide:rejected:${order.id}` },
      ]]
    : [],
})

const followerText = (order: Record<string, any>) => {
  const note = requesterNoteStatuses.includes(order.status) ? order.decision?.note : ''
  return [`Request ${order.reference}: ${statusLabels[order.status] ?? order.status}`, note ? `Reason: ${note}` : '']
    .filter(Boolean).join('\n')
}

export const verifyWebhookSecret = (provided: string | null, expected: string) => {
  const a = Buffer.from(sha256(provided ?? ''))
  const b = Buffer.from(sha256(expected))
  return timingSafeEqual(a, b)
}

export const createBot = (config: BotConfig, { asRole, claimLimit }: BotContext) => {
  const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  const send: Send = async (method, payload) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const result = await response.json() as { ok?: boolean; result?: Record<string, any>; error_code?: number }
    if (!result.ok) throw new Error(`Telegram ${method} failed with ${result.error_code ?? response.status}`)
    return result.result ?? {}
  }

  const reply = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
    send('sendMessage', { chat_id: chatId, text, ...extra })

  const service = <T>(run: (query: Query) => Promise<T>) => asRole('service_role', '', run)

  const loadOrder = async (query: Query, orderId: string) =>
    (await query(`${orderSelect} where po.id = $1`, [orderId])).rows[0]

  const findAdmin = async (telegramUserId: number) => (await service((query) => query(
    `select a.user_id, p.full_name,
       case when a.pending_until > now() then a.pending_order_id end as pending_order_id,
       case when a.pending_until > now() then a.pending_status end as pending_status
     from public.telegram_admins a
     join public.profiles p on p.user_id = a.user_id
     where a.telegram_user_id = $1`,
    [telegramUserId],
  ))).rows[0]

  const clearPending = (telegramUserId: number) => service((query) => query(
    'update public.telegram_admins set pending_order_id = null, pending_status = null, pending_until = null where telegram_user_id = $1',
    [telegramUserId],
  ))

  const sendAlert = async (chatId: number, order: Record<string, any>) => {
    const sent = await reply(chatId, alertText(order), { reply_markup: alertKeyboard(order) })
    await service((query) => query(
      `insert into public.telegram_order_alerts (purchase_order_id, chat_id, message_id) values ($1, $2, $3)
       on conflict (purchase_order_id, chat_id) do update set message_id = excluded.message_id`,
      [order.id, chatId, sent.message_id],
    ))
  }

  // The alert row is claimed first, so a retry never alerts twice, and released if sending fails.
  const sendClaimedAlerts = async (order: Record<string, any>, chats: Record<string, any>[]) => {
    await Promise.all(chats.map(async ({ chat_id: chatId }) => {
      try {
        await sendAlert(Number(chatId), order)
      } catch (error) {
        console.error('telegram alert failed', (error as Error).message)
        await service((query) => query(
          'delete from public.telegram_order_alerts where purchase_order_id = $1 and chat_id = $2',
          [order.id, chatId],
        ))
      }
    }))
  }

  const claimAlerts = async (query: Query, orderId: string, audience: string, params: unknown[] = []) => (await query(
    `insert into public.telegram_order_alerts (purchase_order_id, chat_id)
     select $1::uuid, a.telegram_user_id
     from public.telegram_admins a
     join public.profiles p on p.user_id = a.user_id
     where ${audience}
     on conflict do nothing
     returning chat_id`,
    [orderId, ...params],
  )).rows

  // New requests go to the department's admins. The super-admin hears about approvals only.
  const notifyNewOrder = async (reference: string) => {
    const { order, chats } = await service(async (query) => {
      const { rows } = await query(`${orderSelect} where po.reference = $1`, [reference])
      const found = rows[0]
      if (!found) return { order: null, chats: [] as Record<string, any>[] }
      return { order: found, chats: await claimAlerts(query, found.id, 'p.department_id = $2', [found.department_id]) }
    })
    if (order) await sendClaimedAlerts(order, chats)
  }

  // Refresh every admin's alert and tell anyone tracking the request.
  const notifyStatusChange = async (orderId: string) => {
    const { order, alerts, followers, superAdmins } = await service(async (query) => {
      const found = await loadOrder(query, orderId)
      return {
        order: found,
        alerts: (await query(
          'select chat_id, message_id from public.telegram_order_alerts where purchase_order_id = $1 and message_id is not null',
          [orderId],
        )).rows,
        followers: (await query('select chat_id from public.telegram_order_followers where purchase_order_id = $1', [orderId])).rows,
        superAdmins: found?.status === 'approved' ? await claimAlerts(query, orderId, `p.role = 'global_admin'`) : [],
      }
    })
    if (!order) return
    await sendClaimedAlerts(order, superAdmins)
    const deliveries = [
      ...alerts.map(({ chat_id: chatId, message_id: messageId }) => send('editMessageText', {
        chat_id: Number(chatId),
        message_id: Number(messageId),
        text: alertText(order),
        reply_markup: alertKeyboard(order),
      })),
      ...followers.map(({ chat_id: chatId }) => reply(Number(chatId), followerText(order))),
    ]
    for (const result of await Promise.allSettled(deliveries)) {
      if (result.status === 'rejected') console.error('telegram update failed', (result.reason as Error).message)
    }
  }

  const issueAdminLink = async (userId: string, minutes = adminLinkMinutes) => {
    const code = randomBytes(18).toString('base64url')
    await service(async (query) => {
      await query('delete from public.telegram_link_codes where expires_at < now()')
      await query(
        `insert into public.telegram_link_codes (code_hash, user_id, expires_at)
         values ($1, $2, now() + make_interval(mins => $3))`,
        [sha256(code), userId, minutes],
      )
    })
    return `https://t.me/${config.username}?start=${code}`
  }

  const connectAdmin = async (chatId: number, code: string) => {
    await claimLimit('telegram-connect', String(chatId), 20)
    const profile = await service(async (query) => {
      const { rows } = await query(
        'delete from public.telegram_link_codes where code_hash = $1 and expires_at >= now() returning user_id',
        [sha256(code)],
      )
      if (!rows[0]) return null
      await query(
        `insert into public.telegram_admins (telegram_user_id, user_id) values ($1, $2)
         on conflict (telegram_user_id) do update set user_id = excluded.user_id, linked_at = now(),
           pending_order_id = null, pending_status = null, pending_until = null`,
        [chatId, rows[0].user_id],
      )
      return (await query('select full_name from public.profiles where user_id = $1', [rows[0].user_id])).rows[0]
    })
    if (!profile) return reply(chatId, 'That connection link has expired or was already used. Ask for a new one.')
    return reply(chatId, `Connected as ${profile.full_name}. New requests will appear here. Send /pending to see open requests.`)
  }

  const followOrder = async (chatId: number, rawCode: string) => {
    await claimLimit('telegram-track', String(chatId), 20)
    const order = await service(async (query) => {
      const { rows } = await query(`${orderSelect} where po.request_code_hash = $1`, [sha256(rawCode.toUpperCase())])
      if (rows[0]) {
        await query(
          'insert into public.telegram_order_followers (purchase_order_id, chat_id) values ($1, $2) on conflict do nothing',
          [rows[0].id, chatId],
        )
      }
      return rows[0]
    })
    if (!order) return reply(chatId, 'No request matched that code. Check it and send it again.')
    return reply(chatId, `${followerText(order)}\n\nYou will get a message here when this changes. Send /stop to turn this off.`)
  }

  const showFollowed = async (chatId: number) => {
    const { rows } = await service((query) => query(
      `select po.reference, po.status from public.telegram_order_followers f
       join public.purchase_orders po on po.id = f.purchase_order_id
       where f.chat_id = $1 order by po.created_at desc limit 20`,
      [chatId],
    ))
    if (!rows.length) return reply(chatId, 'You are not tracking a request. Send your request code to start.')
    return reply(chatId, rows.map((order) => `${order.reference}: ${statusLabels[order.status] ?? order.status}`).join('\n'))
  }

  const showPending = async (chatId: number, userId: string) => {
    // Row-level security limits this to the admin's own department.
    const orders = await asRole('authenticated', userId, async (query) => (await query(
      `${orderSelect} where po.status in ('submitted', 'under_review', 'needs_information') order by po.created_at limit 11`,
    )).rows)
    if (!orders.length) return reply(chatId, 'There are no open requests.')
    for (const order of orders.slice(0, 10)) await sendAlert(chatId, order)
    if (orders.length > 10) await reply(chatId, 'Showing the oldest 10. Decide these, then send /pending for more.')
  }

  const stop = async (chatId: number) => {
    await service(async (query) => {
      await query('delete from public.telegram_order_followers where chat_id = $1', [chatId])
      await query('delete from public.telegram_admins where telegram_user_id = $1', [chatId])
    })
    return reply(chatId, 'Done. You will not get any more messages from PO Desk.')
  }

  const help = (chatId: number, admin: boolean) => reply(chatId, admin
    ? 'New requests appear here with Accept and Deny buttons.\n\n/pending shows open requests\n/cancel stops a decision\n/stop disconnects this chat'
    : 'Send your request code, like 7K2M-B4WN, to track your request.\n\n/status shows requests you are tracking\n/stop turns off updates')

  const finishDecision = async (chatId: number, admin: Record<string, any>, reason: string) => {
    if (reason.length < minReasonLength) return reply(chatId, 'Please give a reason of at least a few words.')
    if (reason.length > maxReasonLength) return reply(chatId, `Please keep the reason under ${maxReasonLength} characters.`)
    const status = admin.pending_status as string
    const orderId = admin.pending_order_id as string
    try {
      await asRole('authenticated', admin.user_id, (query) => query(
        'select public.transition_purchase_order($1::uuid, $2::public.order_status, $3)',
        [orderId, status, reason],
      ))
    } catch (error) {
      if ((error as { code?: string }).code !== 'P0001') throw error
      await clearPending(chatId)
      return reply(chatId, 'That request was already decided, so nothing changed.')
    }
    await clearPending(chatId)
    await notifyStatusChange(orderId)
    return reply(chatId, `Saved: ${statusLabels[status]}.`)
  }

  const handleMessage = async (message: Record<string, any>) => {
    const chatId = Number(message.chat.id)
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    const admin = await findAdmin(chatId)

    if (text.startsWith('/')) {
      const [rawCommand = '', argument = ''] = text.split(/\s+/)
      const command = rawCommand.split('@')[0]!.toLowerCase()
      if (command === '/start' && argument) {
        return requestCodePattern.test(argument.toUpperCase()) ? followOrder(chatId, argument) : connectAdmin(chatId, argument)
      }
      if (command === '/status') return showFollowed(chatId)
      if (command === '/stop') return stop(chatId)
      if (command === '/pending' && admin) return showPending(chatId, admin.user_id)
      if (command === '/cancel' && admin) {
        await clearPending(chatId)
        return reply(chatId, 'Cancelled. Nothing changed.')
      }
      return help(chatId, Boolean(admin))
    }

    if (admin?.pending_order_id) {
      if (!text) return reply(chatId, 'Please type your reason, or send /cancel.')
      return finishDecision(chatId, admin, text)
    }
    if (requestCodePattern.test(text.toUpperCase())) return followOrder(chatId, text)
    return help(chatId, Boolean(admin))
  }

  const handleDecisionTap = async (callback: Record<string, any>) => {
    const chatId = Number(callback.from.id)
    const answer = (text: string) => send('answerCallbackQuery', { callback_query_id: callback.id, text })
    const match = decisionPattern.exec(String(callback.data ?? ''))
    if (!match) return answer('That button is no longer available.')
    const [, status, orderId] = match
    const admin = await findAdmin(chatId)
    if (!admin) return answer('This chat is not connected to an admin login.')
    // Row-level security hides requests from other departments.
    const order = await asRole('authenticated', admin.user_id, (query) => loadOrder(query, orderId!))
    if (!order) return answer('You cannot decide this request.')
    if (!openStatuses.includes(order.status)) {
      await send('editMessageText', {
        chat_id: chatId,
        message_id: callback.message?.message_id,
        text: alertText(order),
        reply_markup: alertKeyboard(order),
      }).catch(() => undefined)
      return answer('This request was already decided.')
    }
    await service((query) => query(
      `update public.telegram_admins
       set pending_order_id = $1, pending_status = $2::public.order_status,
         pending_until = now() + make_interval(mins => $3)
       where telegram_user_id = $4`,
      [orderId, status, reasonWindowMinutes, chatId],
    ))
    await answer('Please give a reason.')
    return reply(chatId, `Why are you ${status === 'approved' ? 'accepting' : 'denying'} ${order.reference}? The requester will see your reason.\n\nSend /cancel to stop.`, {
      reply_markup: { force_reply: true, input_field_placeholder: 'Type your reason' },
    })
  }

  const handleUpdate = async (update: Record<string, any>) => {
    const callback = update.callback_query
    const message = update.message
    const chat = callback?.message?.chat ?? message?.chat
    if (chat?.type !== 'private') return
    try {
      if (callback) await handleDecisionTap(callback)
      else if (message) await handleMessage(message)
    } catch (error) {
      const limited = (error as { status?: number }).status === 429
      if (!limited) console.error('telegram update failed', (error as { code?: string; message?: string }).code ?? (error as Error).message)
      await reply(Number(chat.id), limited ? 'Too many tries. Please wait and try again later.' : 'Something went wrong. Please try again.')
        .catch(() => undefined)
    }
  }

  return { handleUpdate, issueAdminLink, notifyNewOrder, notifyStatusChange }
}
