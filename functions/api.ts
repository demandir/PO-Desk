import { attachDatabasePool, waitUntil } from '@neon/functions'
import { Pool } from 'pg'
import { createApi, type Database } from './handler.ts'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
attachDatabasePool(pool)

const database: Database = {
  async transaction(run) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const result = await run((sql, params) => client.query(sql, params))
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  },
}

const handle = createApi({
  database,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  authSecret: process.env.AUTH_SECRET!,
  rateLimitSalt: process.env.RATE_LIMIT_SALT!,
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
  telegram: process.env.TELEGRAM_BOT_TOKEN
    ? {
        token: process.env.TELEGRAM_BOT_TOKEN,
        webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
        username: process.env.TELEGRAM_BOT_USERNAME!,
      }
    : undefined,
  runInBackground: waitUntil,
})

export default { fetch: handle }
