import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_database_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
})
import { db, Prisma, transaction } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { verifyDatabase } from './database-catalog'
import { initializeDatabase } from './database-init'
import { databaseNow, claimJob, claimEmail } from './database-sql'
import { seedDatabase } from '../../scripts/seed'
import { id } from './crypto'
import { userView } from './data'
import { newOrder } from './services'
import { defaultReferralTiers } from '../referral'
import { defaultPlanPrices, defaultUpgradeMarkupBps } from '../pricing'
import { updateCommercialPolicy } from '../../scripts/update-commercial-policy'
import { settingsData } from './data'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('Prisma schema, clock, seeding and worker invariants', () => {
  beforeAll(prepareTestDatabase, 30_000)
  afterAll(cleanupTestDatabase)

  it('replays every column, constraint, index, function and trigger from an empty schema', async () => {
    const contract = await verifyDatabase()
    expect(contract.triggers).toHaveLength(6)
    expect(contract.functions).toHaveLength(6)
  })

  it('refuses to initialize an occupied schema without changing its contents', async () => {
    await expect(initializeDatabase(process.env.DATABASE_URL!)).rejects.toThrow('empty schema')
    await verifyDatabase()
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
    expect((original.body as Prisma.JsonObject).firstOrderOnly).toBe(false)
    expect((original.body as Prisma.JsonObject).referralTiers).toEqual(defaultReferralTiers)
    expect((original.body as Prisma.JsonObject).rateBps).toBe(300)
    for (const [plan, price] of Object.entries(defaultPlanPrices))
      expect((await db.product.findFirstOrThrow({ where: { plan, upgrade: false } })).price).toBe(
        price,
      )
    expect(settingsData(original.body).upgradePricing?.markupBps).toBe(defaultUpgradeMarkupBps)
    await db.product.update({ where: { id: 'plus' }, data: { price: 43210 } })
    await db.setting.update({
      where: { id: 1 },
      data: {
        body: {
          ...(original.body as Prisma.JsonObject),
          supportEmail: 'owner@example.com',
          firstOrderOnly: true,
        },
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

  it('rolls out prices and rates while preserving unrelated settings and existing snapshots', async () => {
    const before = settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)
    const upgrades = await db.product.findMany({ where: { upgrade: true } })
    const oldOrders = await db.order.findMany()
    const oldQuotes = await db.quote.findMany()
    const oldCommissions = await db.commission.findMany()
    await transaction(updateCommercialPolicy)
    const after = settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)
    expect(after).toMatchObject({
      supportEmail: before.supportEmail,
      firstOrderOnly: before.firstOrderOnly,
      settlementDays: before.settlementDays,
      rateBps: 300,
      upgradePricing: { ...before.upgradePricing, markupBps: 3000, targets: expect.any(Object) },
    })
    expect(after.referralTiers?.map((tier) => tier.rateBps)).toEqual([300, 400, 500, 600])
    expect(after.referralTiers?.map(({ rateBps: _, ...tier }) => tier)).toEqual(
      before.referralTiers?.map(({ rateBps: _, ...tier }) => tier),
    )
    for (const target of Object.values(after.upgradePricing!.targets!))
      expect(target.markupBps).toBe(3000)
    for (const [plan, price] of Object.entries(defaultPlanPrices))
      expect(await db.product.findFirstOrThrow({ where: { plan, upgrade: false } })).toMatchObject({
        price,
        priceCurrency: 'CNY',
        pricingMode: 'fixed',
      })
    expect(await db.product.findMany({ where: { upgrade: true } })).toEqual(upgrades)
    expect(await db.order.findMany()).toEqual(oldOrders)
    expect(await db.quote.findMany()).toEqual(oldQuotes)
    expect(await db.commission.findMany()).toEqual(oldCommissions)
    await transaction(updateCommercialPolicy)
    expect(settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)).toEqual(
      after,
    )
    expect(await db.audit.count({ where: { target: 'commercial-policy' } })).toBe(2)
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
