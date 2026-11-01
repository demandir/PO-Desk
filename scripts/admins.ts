// Creates the admin logins, or resets one password. Passwords are written only to
// the git-ignored admin-logins.txt, never to the terminal.
//   npm run admins            create any missing accounts
//   npm run admins -- capa    reset the password for one account
import { randomInt } from 'node:crypto'
import { appendFile, chmod } from 'node:fs/promises'
import { Client } from '@neondatabase/serverless'
import { hashPassword } from '../functions/password.ts'

const accounts = [
  { username: 'admin', fullName: 'Super Admin', departmentCode: null },
  { username: 'facilities', fullName: 'Facilities Admin', departmentCode: 'FAC' },
  { username: 'service', fullName: 'Service Admin', departmentCode: 'SVC' },
  { username: 'capa', fullName: 'CAPA Admin', departmentCode: 'CAPA' },
  { username: 'mahila', fullName: 'Mahila Admin', departmentCode: 'MAH' },
  { username: 'satsang', fullName: 'Satsang Admin', departmentCode: 'SAT' },
  { username: 'accounting', fullName: 'Accounting Admin', departmentCode: 'ACCT' },
  { username: 'avit', fullName: 'AV/IT Admin', departmentCode: 'AVIT' },
  { username: 'ibky', fullName: 'iBKY Admin', departmentCode: 'IBKY' },
]

const alphabet = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
const makePassword = () => Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('')

const outputFile = process.env.ADMIN_LOGINS_FILE ?? 'admin-logins.txt'
const resetUsername = process.argv[2]?.toLowerCase()
if (resetUsername && !accounts.some(({ username }) => username === resetUsername)) {
  throw new Error(`Unknown username: ${resetUsername}`)
}

const client = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED })
await client.connect()
try {
  let changed = 0
  for (const { username, fullName, departmentCode } of accounts) {
    const existing = await client.query('select id from auth.users where username = $1', [username])
    if (existing.rows[0] && username !== resetUsername) continue
    if (!existing.rows[0] && resetUsername) continue
    const password = makePassword()
    const hash = await hashPassword(password)
    await client.query('begin')
    try {
      if (existing.rows[0]) {
        await client.query('update auth.users set password_hash = $1, password_changed_at = now() where username = $2', [hash, username])
      } else {
        const user = await client.query('insert into auth.users (username, password_hash) values ($1, $2) returning id', [username, hash])
        await client.query(
          `insert into public.profiles (user_id, full_name, role, department_id)
           select $1::uuid, $2, $3::public.admin_role, (select id from public.departments where code = $4)`,
          [user.rows[0].id, fullName, departmentCode ? 'department_admin' : 'global_admin', departmentCode],
        )
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    }
    await appendFile(outputFile, `${username}\t${password}\n`, { mode: 0o600 })
    await chmod(outputFile, 0o600)
    changed += 1
  }
  console.log(`${changed} login(s) written to ${outputFile}`)
} finally {
  await client.end()
}
