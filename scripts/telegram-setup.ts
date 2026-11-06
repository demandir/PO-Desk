// Points Telegram at the deployed function and sets the bot's command menu.
// Run once, and again if the API address or webhook secret changes.
//   npm run telegram:setup
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_API_URL: apiUrl } = process.env
if (!token || !secret || !apiUrl) throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_API_URL in .env.local')

const call = async (method: string, payload: Record<string, unknown>) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json() as { ok?: boolean; description?: string }
  if (!result.ok) throw new Error(`${method} failed: ${result.description ?? response.status}`)
}

await call('setWebhook', {
  url: `${apiUrl.replace(/\/$/, '')}/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
})
await call('setMyCommands', {
  commands: [
    { command: 'status', description: 'Show requests you are tracking' },
    { command: 'pending', description: 'Admins: show open requests' },
    { command: 'connect', description: 'Admins: post requests in this group' },
    { command: 'cancel', description: 'Admins: stop a decision' },
    { command: 'stop', description: 'Stop all messages' },
  ],
})
console.log('Telegram webhook and commands are set')

export {}
