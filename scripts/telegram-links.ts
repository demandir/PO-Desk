// Creates one-time Telegram connection links for admins. Links are written only to
// the git-ignored telegram-links.txt, never to the terminal, and last 3 days.
//   npm run telegram:links            one link for every admin
//   npm run telegram:links -- capa    one link for one admin
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, chmod } from 'node:fs/promises'
import { Client } from '@neondatabase/serverless'

const outputFile = 'telegram-links.txt'
const botUsername = process.env.TELEGRAM_BOT_USERNAME
if (!botUsername) throw new Error('Set TELEGRAM_BOT_USERNAME in .env.local')
const username = process.argv[2]?.toLowerCase()

const client = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED })
await client.connect()
try {
  const { rows } = await client.query(
    `select u.id, u.username from auth.users u
     join public.profiles p on p.user_id = u.id
     where $1::text is null or u.username = $1
     order by u.username`,
    [username ?? null],
  )
  if (!rows.length) throw new Error(`Unknown username: ${username}`)
  for (const { id, username: name } of rows) {
    const code = randomBytes(18).toString('base64url')
    await client.query(
      `insert into public.telegram_link_codes (code_hash, user_id, expires_at) values ($1, $2, now() + interval '3 days')`,
      [createHash('sha256').update(code).digest('hex'), id],
    )
    await appendFile(outputFile, `${name}\thttps://t.me/${botUsername}?start=${code}\n`, { mode: 0o600 })
  }
  await chmod(outputFile, 0o600)
  console.log(`${rows.length} link(s) written to ${outputFile}`)
} finally {
  await client.end()
}
