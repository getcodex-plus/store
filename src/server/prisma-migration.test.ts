import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_migration_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
})
import { db, Prisma, transaction } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { verifyDatabase } from './database-catalog'
import { databaseNow, claimJob, claimEmail } from './database-sql'
import { seedDatabase } from '../../scripts/seed'
import { id } from './crypto'
import { userView } from './data'
import { newOrder } from './services'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('Prisma schema, clock, seeding and worker invariants', () => {
  beforeAll(prepareTestDatabase, 30_000)
  afterAll(cleanupTestDatabase)

  it('replays every column, constraint, index, function and trigger from an empty schema', async () => {
    const contract = await verifyDatabase()
    expect(contract.triggers).toHaveLength(6)
    expect(contract.functions).toHaveLength(6)
  })

  it('uses UTC for database timestamps even when the server defaults to another timezone', async () => {
    const now = await databaseNow()
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(2000)
    const [{ zone }] = await db.$queryRaw<
      { zone: string }[]
    >`SELECT current_setting('TimeZone') AS zone`
    expect(zone).toBe('UTC')
    const key = id('clock_')
    await db.$executeRaw`INSERT INTO auth_verification(id,identifier,value,"expiresAt")
      VALUES(${key},${key},'clock',now()-interval '1 second')`
    const record = await db.authVerification.findUniqueOrThrow({ where: { id: key } })
    expect(record.expiresAt.getTime()).toBeLessThan(Date.now())
    expect(Date.now() - record.expiresAt.getTime()).toBeLessThan(3000)
  })

  it('seeds missing records without overwriting prices, configuration or role changes', async () => {
    await transaction(seedDatabase)
    const original = await db.setting.findUniqueOrThrow({ where: { id: 1 } })
    await db.product.update({ where: { id: 'plus' }, data: { price: 43210 } })
    await db.setting.update({
      where: { id: 1 },
      data: {
        body: { ...(original.body as Prisma.JsonObject), supportEmail: 'owner@example.com' },
      },
    })
    await db.role.update({ where: { id: 'support' }, data: { name: 'Custom support' } })
    const before = await db.setting.findUniqueOrThrow({ where: { id: 1 } })
    await transaction(seedDatabase)
    expect((await db.product.findUniqueOrThrow({ where: { id: 'plus' } })).price).toBe(43210)
    expect(await db.setting.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before)
    expect((await db.role.findUniqueOrThrow({ where: { id: 'support' } })).name).toBe(
      'Custom support',
    )
  })

  it('keeps partial account uniqueness without treating every provider as one-to-one', async () => {
    const user = await db.user.create({
      data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
    })
    const data = { userId: user.id, accountId: user.id, updatedAt: new Date() }
    await db.authAccount.create({
      data: { ...data, id: id(), providerId: 'opaque', registrationRecord: id() },
    })
    await db.authAccount.create({ data: { ...data, id: id(), providerId: 'external-fixture' } })
    await expect(
      db.authAccount.create({
        data: { ...data, id: id(), providerId: 'opaque', registrationRecord: id() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await db.authAccount.count({ where: { userId: user.id } })).toBe(2)
  })

  it('leases jobs and outbox entries once under competing worker connections, then recovers an expired lease', async () => {
    const user = userView(
      await db.user.create({
        data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
      }),
    )
    const order = await newOrder(user, id(), { amount: 1000, channel: 'alipay', requestKey: id() })
    await db.job.create({ data: { id: id('job_'), orderId: order.id } })
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => transaction((client) => claimJob(client, id('lease_')))),
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claimed = await db.job.findUniqueOrThrow({ where: { orderId: order.id } })
    expect(claimed.attempts).toBe(1)
    expect(claimed.lease).toBeTruthy()
    expect(
      (await Promise.all(Array.from({ length: 8 }, () => claimEmail()))).filter(Boolean),
    ).toHaveLength(1)
    expect((await db.emailOutbox.findFirstOrThrow({ where: { orderId: order.id } })).attempts).toBe(
      1,
    )
    await db.job.update({
      where: { id: claimed.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    })
    const recovered = await transaction((client) => claimJob(client, 'recovered'))
    expect(recovered?.id).toBe(claimed.id)
    expect((await db.job.findUniqueOrThrow({ where: { id: claimed.id } })).attempts).toBe(2)
  })
})
