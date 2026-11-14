import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const connection = process.env.TEST_DATABASE_URL
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('E2E requires TEST_DATABASE_URL pointing to a dedicated _test database')
const baseURL = new URL(process.env.E2E_BASE_URL || 'http://localhost:3100')
if (baseURL.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(baseURL.hostname))
  throw new Error('E2E starts its own local demo server; use a loopback HTTP URL')

const schema = `test_e2e_${randomUUID().replaceAll('-', '')}`
const target = new URL(connection)
target.searchParams.set('schema', schema)
Object.assign(process.env, {
  DATABASE_URL: target.toString(),
  APP_MODE: 'demo',
  APP_URL: baseURL.origin,
  E2E_BASE_URL: baseURL.origin,
  E2E_DATABASE_PREPARED: 'true',
  ADMIN_EMAIL: 'admin@example.com',
})
const { db, createDatabase, Prisma } = await import('../src/server/db')
const { seedDatabase } = await import('./seed')
const { initializeDatabase } = await import('../src/server/database-init')
const { jsonInput, settingsData } = await import('../src/server/data')
const adminURL = new URL(connection)
adminURL.searchParams.set('schema', 'public')
const admin = createDatabase(adminURL.toString())

async function run(script: string, args: string[]) {
  const child = spawn(process.execPath, [resolve(script), ...args], {
    env: process.env,
    stdio: 'inherit',
  })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) throw new Error(`${script} exited with ${code ?? 'a signal'}`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

let created = false
try {
  await admin.$executeRaw(Prisma.sql`CREATE SCHEMA ${Prisma.raw(`"${schema}"`)}`)
  created = true
  await initializeDatabase(target.toString())
  await db.$transaction(seedDatabase)
  const settings = await db.setting.findUniqueOrThrow({ where: { id: 1 } })
  await db.setting.update({
    where: { id: 1 },
    data: {
      body: jsonInput({
        ...settingsData(settings.body),
        supportEmail: 'support@example.com',
        sessionGuideUrl: 'https://support.example.com/account-guide',
      }),
    },
  })
  // Deterministic test fixtures, never production seed data or live market rates.
  const now = new Date()
  await db.exchangeRate.updateMany({
    data: {
      rateE8: 720_000_000n,
      sourceDate: now.toISOString().slice(0, 10),
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 3600_000),
      refreshAfter: new Date(now.getTime() + 48 * 3600_000),
      source: 'E2E fixture',
    },
  })
  console.log('E2E database initialized and seeded in an isolated schema.')
  await run('node_modules/@playwright/test/cli.js', ['test', ...process.argv.slice(2)])
} finally {
  await db.$disconnect()
  try {
    if (created)
      await admin.$executeRaw(Prisma.sql`DROP SCHEMA ${Prisma.raw(`"${schema}"`)} CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}
