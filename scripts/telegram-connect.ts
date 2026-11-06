// Creates a one-time code that connects a Telegram group to PO Desk. Everyone in that
// group can accept or deny requests, so only share it with the group you mean.
//   npm run telegram:connect
// Then send /connect followed by the code in the group. The code lasts one hour.
import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@neondatabase/serverless'

const code = randomBytes(9).toString('base64url')
const client = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED })
await client.connect()
try {
  await client.query('delete from public.telegram_group_codes where expires_at < now()')
  await client.query(
    `insert into public.telegram_group_codes (code_hash, expires_at) values ($1, now() + interval '1 hour')`,
    [createHash('sha256').update(code).digest('hex')],
  )
} finally {
  await client.end()
}
console.log(`Send this in the Telegram group within one hour:\n\n/connect ${code}`)
