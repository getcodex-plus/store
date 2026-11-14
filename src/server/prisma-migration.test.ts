import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

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
import { completeOrder, newOrder } from './services'
import { defaultReferralTiers } from '../referral'

const lowerReferralRatesMigration = () =>
  readFile(
    new URL(
      '../../prisma/migrations/20261114030000_lower_referral_rates/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )

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

  it('accepts the historical baseline but requires retired columns to be removed for current installs', async () => {
    await transaction(async (client) => {
      await client.$executeRaw`ALTER TABLE products ADD COLUMN service_terms text NOT NULL DEFAULT ''`
      await client.$executeRaw`ALTER TABLE quotes ADD COLUMN service_terms text NOT NULL DEFAULT ''`
      await client.$executeRaw`ALTER TABLE orders ADD COLUMN service_terms text NOT NULL DEFAULT ''`
      await verifyDatabase(client, true)
      await expect(verifyDatabase(client)).rejects.toThrow('Removed columns still present')
      await client.$executeRaw`ALTER TABLE products DROP COLUMN service_terms`
      await client.$executeRaw`ALTER TABLE quotes DROP COLUMN service_terms`
      await client.$executeRaw`ALTER TABLE orders DROP COLUMN service_terms`
      await verifyDatabase(client)
    })
  })

  it('seeds missing records without overwriting prices, configuration or role changes', async () => {
    await transaction(seedDatabase)
    const original = await db.setting.findUniqueOrThrow({ where: { id: 1 } })
    expect((original.body as Prisma.JsonObject).firstOrderOnly).toBe(false)
    expect((original.body as Prisma.JsonObject).referralTiers).toEqual(defaultReferralTiers)
    expect((original.body as Prisma.JsonObject).rateBps).toBe(200)
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

  it('migrates existing referral settings while preserving other settings and order snapshots', async () => {
    const before = await db.setting.findUniqueOrThrow({ where: { id: 1 } })
    expect((before.body as Prisma.JsonObject).firstOrderOnly).toBe(true)
    const buyer = userView(
      await db.user.create({
        data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
      }),
    )
    const order = await newOrder(buyer, id(), {
      amount: 1000,
      channel: 'alipay',
      requestKey: id(),
    })
    expect(order.firstOrderOnly).toBe(true)
    const migration = await readFile(
      new URL(
        '../../prisma/migrations/20261114010000_recurring_referral_rewards/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )
    // The migration is repository-owned SQL; replay also verifies idempotence.
    await db.$executeRawUnsafe(migration)
    await db.$executeRawUnsafe(migration)
    expect((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).toEqual({
      ...(before.body as Prisma.JsonObject),
      firstOrderOnly: false,
    })
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).firstOrderOnly).toBe(
      true,
    )
    const next = await newOrder(buyer, id(), {
      amount: 1000,
      channel: 'alipay',
      requestKey: id(),
    })
    expect(next.firstOrderOnly).toBe(false)
    await db.emailOutbox.deleteMany({ where: { orderId: { in: [order.id, next.id] } } })
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

  it('lowers default rates without changing tier metadata, saved orders or earned commissions', async () => {
    const original = (await db.setting.findUniqueOrThrow({ where: { id: 1 } }))
      .body as Prisma.JsonObject
    const tiers = defaultReferralTiers.map((tier, index) => ({
      ...tier,
      name: `自定义名称${index}`,
      minimumInvites: index * 10,
      rateBps: [300, 500, 700, 900][index],
    }))
    const owner = await db.user.create({
      data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
    })
    const orderData = {
      productName: 'Historical purchase',
      email: `${id()}@example.com`,
      amount: 10000,
      externalAmount: 10000,
      channel: 'alipay',
      provider: 'xorpay',
      rateBps: 900,
      settlementDays: 7,
      firstOrderOnly: false,
      inviterId: owner.id,
    }
    const unpaid = await db.order.create({
      data: { ...orderData, id: id('o_'), status: 'unpaid' },
    })
    const processing = await db.order.create({
      data: { ...orderData, id: id('o_'), status: 'processing' },
    })
    const completed = await db.order.create({
      data: {
        ...orderData,
        id: id('o_'),
        status: 'completed',
        commission: {
          create: {
            id: id('c_'),
            userId: owner.id,
            amount: 900,
            status: 'available',
            availableAt: new Date(),
          },
        },
      },
      include: { commission: true },
    })
    try {
      const before = { ...original, rateBps: 300, referralTiers: tiers }
      await db.setting.update({ where: { id: 1 }, data: { body: before } })
      const migration = await lowerReferralRatesMigration()
      await db.$executeRawUnsafe(migration)
      await db.$executeRawUnsafe(migration)
      expect((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).toEqual({
        ...before,
        rateBps: 200,
        referralTiers: tiers.map((tier, index) => ({
          ...tier,
          rateBps: [200, 300, 400, 500][index],
        })),
      })
      expect(await db.order.findUniqueOrThrow({ where: { id: unpaid.id } })).toEqual(unpaid)
      expect(
        await db.order.findUniqueOrThrow({
          where: { id: completed.id },
          include: { commission: true },
        }),
      ).toEqual(completed)
      await completeOrder(processing.id)
      expect(
        await db.commission.findUniqueOrThrow({ where: { orderId: processing.id } }),
      ).toMatchObject({ amount: 900, status: 'pending' })
      const next = await newOrder(userView(owner), id(), {
        amount: 1000,
        channel: 'alipay',
        requestKey: id(),
      })
      expect(next.rateBps).toBe(200)
      await db.emailOutbox.deleteMany({ where: { orderId: next.id } })
    } finally {
      await db.setting.update({ where: { id: 1 }, data: { body: original } })
    }
  })

  it.each(['missing', 'null', 'custom'] as const)(
    'handles %s referral tiers during the rate migration',
    async (kind) => {
      const original = (await db.setting.findUniqueOrThrow({ where: { id: 1 } }))
        .body as Prisma.JsonObject
      const before: Prisma.JsonObject = { ...original, rateBps: 300 }
      delete before.referralTiers
      if (kind === 'null') before.referralTiers = null
      if (kind === 'custom')
        before.referralTiers = defaultReferralTiers.map((tier, index) => ({
          ...tier,
          rateBps: [300, 400, 600, 800][index],
        }))
      try {
        await db.setting.update({ where: { id: 1 }, data: { body: before } })
        await db.$executeRawUnsafe(await lowerReferralRatesMigration())
        expect((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).toEqual(
          kind === 'custom'
            ? before
            : { ...before, rateBps: 200, referralTiers: defaultReferralTiers },
        )
      } finally {
        await db.setting.update({ where: { id: 1 }, data: { body: original } })
      }
    },
  )

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
