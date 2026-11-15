import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_order_ip_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { db } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { seedDatabase } from '../../scripts/seed'
import { adminOrderView, orderView, userView } from './data'
import { newOrder, quote } from './services'
import { demoSession } from '../lib'
import { id } from './crypto'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('Order IP snapshots', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.$transaction(seedDatabase)
  }, 30000)
  afterAll(cleanupTestDatabase)

  it.each(['guest', 'purchase', 'topup'] as const)(
    'records the first IP for %s and preserves it across retries',
    async (kind) => {
      const email = `${id()}@example.com`
      const user =
        kind === 'guest'
          ? null
          : userView(await db.user.create({ data: { id: id(), email, referralCode: id() } }))
      const browser = id()
      const q = kind === 'topup' ? null : await quote('plus', demoSession(email), browser)
      const input = {
        ...(q ? { quoteId: q.id } : { amount: 1000 }),
        channel: 'alipay' as const,
        contactEmail: email,
        requestKey: id(),
      }
      const order = await newOrder(user, browser, input, '192.0.2.10')
      const retry = await newOrder(user, browser, input, '198.51.100.10')
      expect(retry.id).toBe(order.id)
      if (q) {
        const quoteRetry = await newOrder(
          user,
          browser,
          { ...input, requestKey: id() },
          '203.0.113.10',
        )
        expect(quoteRetry.id).toBe(order.id)
      }
      const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(stored.ipAddress).toBe('192.0.2.10')
      expect(adminOrderView(stored).ipAddress).toBe('192.0.2.10')
      expect(order).not.toHaveProperty('ipAddress')
      expect(orderView(stored)).not.toHaveProperty('ipAddress')
    },
  )

  it('keeps an unknown IP null instead of inventing or backfilling an address', async () => {
    const email = `${id()}@example.com`
    const browser = id()
    const q = await quote('plus', demoSession(email), browser)
    const input = {
      quoteId: q.id,
      channel: 'alipay' as const,
      contactEmail: email,
      requestKey: id(),
    }
    const order = await newOrder(null, browser, input)
    await newOrder(null, browser, input, '192.0.2.10')
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).ipAddress).toBeNull()
  })
})
