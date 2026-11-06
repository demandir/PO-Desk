import { createHash, timingSafeEqual } from 'node:crypto'
import type { Query } from './handler.ts'
import { requestCodePattern } from './validation.ts'

type Role = 'service_role'
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

  const findPending = async (telegramUserId: number) => (await service((query) => query(
    `select purchase_order_id, target_status, chat_id, prompt_message_id
     from public.telegram_pending_decisions
     where telegram_user_id = $1 and expires_at > now()`,
    [telegramUserId],
  ))).rows[0]

  const clearPending = (telegramUserId: number) => service((query) => query(
    'delete from public.telegram_pending_decisions where telegram_user_id = $1',
    [telegramUserId],
  ))

  const groupChatId = async () => {
    const { rows } = await service((query) => query('select chat_id from public.telegram_group'))
    return rows[0] ? Number(rows[0].chat_id) : null
  }

  const sendAlert = async (chatId: number, order: Record<string, any>) => {
    const sent = await reply(chatId, alertText(order), { reply_markup: alertKeyboard(order) })
    await service((query) => query(
      `insert into public.telegram_order_alerts (purchase_order_id, chat_id, message_id) values ($1, $2, $3)
       on conflict (purchase_order_id, chat_id) do update set message_id = excluded.message_id`,
      [order.id, chatId, sent.message_id],
    ))
  }

  // Every new request is posted once in the group. The alert row is claimed first,
  // so a retried submission never posts twice, and released if sending fails.
  const notifyNewOrder = async (reference: string) => {
    const { order, chatId } = await service(async (query) => {
      const group = (await query('select chat_id from public.telegram_group')).rows[0]
      const found = group && (await query(`${orderSelect} where po.reference = $1`, [reference])).rows[0]
      if (!found) return { order: null, chatId: null }
      const claimed = await query(
        `insert into public.telegram_order_alerts (purchase_order_id, chat_id) values ($1, $2)
         on conflict do nothing returning chat_id`,
        [found.id, group.chat_id],
      )
      return { order: found, chatId: claimed.rows[0] ? Number(group.chat_id) : null }
    })
    if (!order || chatId === null) return
    try {
      await sendAlert(chatId, order)
    } catch (error) {
      console.error('telegram alert failed', (error as Error).message)
      await service((query) => query(
        'delete from public.telegram_order_alerts where purchase_order_id = $1 and chat_id = $2',
        [order.id, chatId],
      ))
    }
  }

  // Refresh the posted alert and tell anyone tracking the request.
  const notifyStatusChange = async (orderId: string) => {
    const { order, alerts, followers } = await service(async (query) => ({
      order: await loadOrder(query, orderId),
      alerts: (await query(
        'select chat_id, message_id from public.telegram_order_alerts where purchase_order_id = $1 and message_id is not null',
        [orderId],
      )).rows,
      followers: (await query('select chat_id from public.telegram_order_followers where purchase_order_id = $1', [orderId])).rows,
    }))
    if (!order) return
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

  // Everyone in the connected group can decide requests, so connecting a group
  // needs a one-time code from the person who runs PO Desk.
  const connectGroup = async (chatId: number, code: string) => {
    await claimLimit('telegram-group', String(chatId), 10)
    const connected = code && await service(async (query) => {
      const { rows } = await query(
        'delete from public.telegram_group_codes where code_hash = $1 and expires_at >= now() returning 1',
        [sha256(code)],
      )
      if (!rows[0]) return false
      await query(
        `insert into public.telegram_group (singleton, chat_id) values (true, $1)
         on conflict (singleton) do update set chat_id = excluded.chat_id, connected_at = now()`,
        [chatId],
      )
      await query('delete from public.telegram_pending_decisions')
      return true
    })
    if (!connected) return reply(chatId, 'That code has expired or was already used. Ask for a new one.')
    return reply(chatId, 'New purchase requests will be posted in this group. Anyone here can accept or deny them, with a reason.')
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

  const showPending = async (chatId: number) => {
    const orders = await service(async (query) => (await query(
      `${orderSelect} where po.status in ('submitted', 'under_review', 'needs_information') order by po.created_at limit 11`,
    )).rows)
    if (!orders.length) return reply(chatId, 'There are no open requests.')
    for (const order of orders.slice(0, 10)) await sendAlert(chatId, order)
    if (orders.length > 10) await reply(chatId, 'Showing the oldest 10. Decide these, then send /pending for more.')
  }

  const stop = async (chatId: number) => {
    await service((query) => query('delete from public.telegram_order_followers where chat_id = $1', [chatId]))
    return reply(chatId, 'Done. You will not get any more messages from PO Desk.')
  }

  const help = (chatId: number, place: 'private' | 'group') => reply(chatId, place === 'private'
    ? 'Send your request code, like 7K2M-B4WN, to track your request.\n\n/status shows requests you are tracking\n/stop turns off updates'
    : 'New purchase requests are posted here. Tap Accept or Deny, then reply to my question with a reason.\n\n/pending shows open requests\n/cancel stops your decision')

  const memberName = (user: Record<string, any>) =>
    shorten([user.first_name, user.last_name].filter(Boolean).join(' ').trim() || (user.username ? `@${user.username}` : 'Telegram member'), 60)

  const finishDecision = async (message: Record<string, any>, pending: Record<string, any>, reason: string) => {
    const chatId = Number(message.chat.id)
    const fromId = Number(message.from.id)
    const answer = (text: string) => reply(chatId, text, { reply_parameters: { message_id: message.message_id } })
    if (reason.length < minReasonLength) return answer('Please reply to the question with a reason of at least a few words.')
    if (reason.length > maxReasonLength) return answer(`Please keep the reason under ${maxReasonLength} characters.`)
    const status = String(pending.target_status)
    const orderId = String(pending.purchase_order_id)
    const name = memberName(message.from)
    try {
      await service((query) => query(
        'select public.transition_purchase_order_from_telegram($1::uuid, $2::public.order_status, $3, $4)',
        [orderId, status, reason, `${name} (Telegram)`],
      ))
    } catch (error) {
      if ((error as { code?: string }).code !== 'P0001') throw error
      await clearPending(fromId)
      return answer('That request was already decided, so nothing changed.')
    }
    await clearPending(fromId)
    await notifyStatusChange(orderId)
    return answer(`Saved: ${statusLabels[status]} by ${name}.`)
  }

  const parseCommand = (text: string) => {
    if (!text.startsWith('/')) return null
    const [rawCommand = '', argument = ''] = text.split(/\s+/)
    const [command = '', botName] = rawCommand.toLowerCase().split('@')
    // In a group, ignore commands meant for another bot.
    if (botName && botName !== config.username.toLowerCase()) return { command: '', argument: '' }
    return { command, argument }
  }

  const handlePrivateMessage = async (message: Record<string, any>) => {
    const chatId = Number(message.chat.id)
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    const parsed = parseCommand(text)
    if (parsed) {
      const { command, argument } = parsed
      if (command === '/start' && requestCodePattern.test(argument.toUpperCase())) return followOrder(chatId, argument)
      if (command === '/status') return showFollowed(chatId)
      if (command === '/stop') return stop(chatId)
      return help(chatId, 'private')
    }
    if (requestCodePattern.test(text.toUpperCase())) return followOrder(chatId, text)
    return help(chatId, 'private')
  }

  // In the group, only commands and replies to the reason question are read.
  // Request codes are never looked up here, so they stay private.
  const handleGroupMessage = async (message: Record<string, any>) => {
    const chatId = Number(message.chat.id)
    const fromId = Number(message.from?.id)
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    const groupId = await groupChatId()
    if (message.migrate_to_chat_id && chatId === groupId) {
      await service((query) => query('update public.telegram_group set chat_id = $1', [message.migrate_to_chat_id]))
      return
    }
    const parsed = parseCommand(text)
    if (parsed?.command === '/connect') return connectGroup(chatId, parsed.argument)
    if (chatId !== groupId) return

    if (parsed) {
      if (parsed.command === '/pending') return showPending(chatId)
      if (parsed.command === '/cancel') {
        await clearPending(fromId)
        return reply(chatId, 'Cancelled. Nothing changed.', { reply_parameters: { message_id: message.message_id } })
      }
      if (parsed.command === '/help' || parsed.command === '/start') return help(chatId, 'group')
      return
    }

    const pending = await findPending(fromId)
    const repliedTo = Number(message.reply_to_message?.message_id)
    if (pending && Number(pending.chat_id) === chatId && repliedTo === Number(pending.prompt_message_id)) {
      return finishDecision(message, pending, text)
    }
  }

  const handleDecisionTap = async (callback: Record<string, any>) => {
    const telegramUserId = Number(callback.from.id)
    const chatId = Number(callback.message?.chat?.id)
    const answer = (text: string) => send('answerCallbackQuery', { callback_query_id: callback.id, text, show_alert: true })
    const match = decisionPattern.exec(String(callback.data ?? ''))
    if (!match) return answer('That button is no longer available.')
    const [, status, orderId] = match
    const order = await service((query) => loadOrder(query, orderId!))
    if (!order) return answer('That request no longer exists.')
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
      `insert into public.telegram_pending_decisions (telegram_user_id, purchase_order_id, target_status, chat_id, expires_at)
       values ($1, $2, $3::public.order_status, $4, now() + make_interval(mins => $5))
       on conflict (telegram_user_id) do update set purchase_order_id = excluded.purchase_order_id,
         target_status = excluded.target_status, chat_id = excluded.chat_id,
         prompt_message_id = null, expires_at = excluded.expires_at`,
      [telegramUserId, orderId, status, chatId, reasonWindowMinutes],
    ))
    await send('answerCallbackQuery', { callback_query_id: callback.id, text: 'Please give a reason.' })
    // Mention the member by name, so the reply box opens for them only.
    const name = memberName(callback.from)
    const prompt = await reply(chatId, `${name}, why are you ${status === 'approved' ? 'accepting' : 'denying'} ${order.reference}? Reply to this message with your reason. The requester will see it.\n\nSend /cancel to stop.`, {
      entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: telegramUserId } }],
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Type your reason' },
    })
    await service((query) => query(
      'update public.telegram_pending_decisions set prompt_message_id = $1 where telegram_user_id = $2',
      [prompt.message_id, telegramUserId],
    ))
  }

  const handleUpdate = async (update: Record<string, any>) => {
    const callback = update.callback_query
    const message = update.message
    const chat = callback?.message?.chat ?? message?.chat
    if (!chat || !['private', 'group', 'supergroup'].includes(chat.type)) return
    try {
      if (callback) {
        // Decisions are only taken from alerts in the connected group.
        if (Number(chat.id) !== await groupChatId()) return
        await handleDecisionTap(callback)
      } else if (message) {
        await (chat.type === 'private' ? handlePrivateMessage(message) : handleGroupMessage(message))
      }
    } catch (error) {
      const limited = (error as { status?: number }).status === 429
      if (!limited) console.error('telegram update failed', (error as { code?: string; message?: string }).code ?? (error as Error).message)
      await reply(Number(chat.id), limited ? 'Too many tries. Please wait and try again later.' : 'Something went wrong. Please try again.')
        .catch(() => undefined)
    }
  }

  return { handleUpdate, notifyNewOrder, notifyStatusChange }
}
