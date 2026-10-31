// Applies db/migrations in order, once each. Usage: npm run db:migrate
import { readdir, readFile } from 'node:fs/promises'
import { Client } from '@neondatabase/serverless'

const directory = new URL('../db/migrations/', import.meta.url)
const client = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED })
await client.connect()
try {
  await client.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())')
  await client.query('alter table public.schema_migrations enable row level security')
  const applied = new Set((await client.query('select name from public.schema_migrations')).rows.map((row) => row.name))
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue
    await client.query('begin')
    try {
      await client.query(await readFile(new URL(name, directory), 'utf8'))
      await client.query('insert into public.schema_migrations (name) values ($1)', [name])
      await client.query('commit')
      console.log(`applied ${name}`)
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  }
  await client.query(await readFile(new URL('../db/delmandir.sql', import.meta.url), 'utf8'))
  console.log('departments ready')
} finally {
  await client.end()
}
