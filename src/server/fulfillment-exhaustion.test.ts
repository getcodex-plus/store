import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32)
  const schema = `test_exhaust_${crypto.randomUUID().replaceAll('-', '')}`
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', schema)
    process.env.DATABASE_URL = url.toString()
  }
})

import { cleanupTestDatabase, prepareTestDatabase } from './database-test-support'
import { db } from './db'
import { exhaustFulfillment, fulfillmentRetryExhausted } from './fulfillment-exhaustion'

// The paid order carries every column the exhaust path reads; keep the helper
// explicit so a new NOT NULL column fails here instead of silently in production.
function paidOrder(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    productName: 'ChatGPT Plus',
    email: `${id.replace(/[^a-z0-9]/gi, '')}@example.com`,
    listAmount: 2000,
    amount: 2000,
    status: 'processing',
    channel: 'crypto',
    rateBps: 0,
    settlementDays: 0,
    firstOrderOnly: false,
    provider: 'gmpay',
    externalAmount: 2000,
    fulfillmentStatus: 'processing',
    ...extra,
  }
}

// Pure budget arithmetic runs everywhere — no database needed, so a plain
// `bun run test` still exercises the cap.
describe('fulfillment retry cap', () => {

  it('treats the 20th attempt as exhausted and never means unlimited', () => {
    expect(fulfillmentRetryExhausted(0)).toBe(false)
    expect(fulfillmentRetryExhausted(19)).toBe(false)
    expect(fulfillmentRetryExhausted(20)).toBe(true)
    expect(fulfillmentRetryExhausted(1000)).toBe(true)
  })

  it('honours FULFILLMENT_MAX_ATTEMPTS and falls back to the default for nonsense', () => {
    const saved = process.env.FULFILLMENT_MAX_ATTEMPTS
    try {
      process.env.FULFILLMENT_MAX_ATTEMPTS = '3'
      expect(fulfillmentRetryExhausted(2)).toBe(false)
      expect(fulfillmentRetryExhausted(3)).toBe(true)
      // A typo or a zero must never disable the cap — that is the original bug.
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env.FULFILLMENT_MAX_ATTEMPTS = bad
        expect(fulfillmentRetryExhausted(19)).toBe(false)
        expect(fulfillmentRetryExhausted(20)).toBe(true)
      }
    } finally {
      if (saved === undefined) delete process.env.FULFILLMENT_MAX_ATTEMPTS
      else process.env.FULFILLMENT_MAX_ATTEMPTS = saved
    }
  })
})

// The hand-off touches Postgres, so it follows the project convention: run only
// when a dedicated test database is supplied.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('fulfillment hand-off', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
  })
  afterAll(async () => {
    await cleanupTestDatabase()
  })

  it('moves a stuck order to failed, closes the job and records an audit line', async () => {
    await db.order.create({ data: paidOrder('o_stuck') })
    await db.job.create({
      data: { id: 'j_stuck', orderId: 'o_stuck', attempts: 20, lastError: 'earlier' },
    })

    expect(await exhaustFulfillment('o_stuck', 'UPSTREAM_UNAVAILABLE')).toBe(true)

    const moved = await db.order.findUniqueOrThrow({ where: { id: 'o_stuck' } })
    expect(moved.status).toBe('failed')
    expect(moved.failureReason).toBe('fulfillment_retry_exhausted')
    expect(moved.fulfillmentStatus).toBe('failed')

    const job = await db.job.findUniqueOrThrow({ where: { id: 'j_stuck' } })
    expect(job.done).toBe(true)
    expect(job.lockedUntil).toBeNull()
    expect(job.lastError).toBe('UPSTREAM_UNAVAILABLE')

    const audits = await db.audit.findMany({ where: { target: 'o_stuck' } })
    expect(audits.map((entry) => entry.action)).toContain('出货重试达上限，转人工')
  })

  it('is idempotent and never touches an order that already left processing', async () => {
    await db.order.create({ data: paidOrder('o_completed', { status: 'completed' }) })

    expect(await exhaustFulfillment('o_completed', 'X')).toBe(false)
    expect((await db.order.findUniqueOrThrow({ where: { id: 'o_completed' } })).status).toBe(
      'completed',
    )
    // Unknown order: nothing to move, no throw.
    expect(await exhaustFulfillment('o_never_existed', 'X')).toBe(false)
  })

  it('records why the buyer was not notified when the order has no contact email', async () => {
    await db.order.create({ data: paidOrder('o_noemail', { contactEmail: null }) })

    await exhaustFulfillment('o_noemail', 'X')

    const audits = await db.audit.findMany({ where: { target: 'o_noemail' } })
    expect(audits.map((entry) => entry.action)).toContain('通知未发送：缺少联系邮箱')
  })

  it('queues the buyer email through the outbox trigger', async () => {
    await db.order.create({ data: paidOrder('o_outbox', { contactEmail: 'buyer@example.com' }) })
    const before = await db.emailOutbox.count({ where: { orderId: 'o_outbox' } })

    await exhaustFulfillment('o_outbox', 'X')

    // The status flip is what queues the buyer email; this function never talks
    // to the mail provider itself. Counting the new outbox episode is the real
    // boundary — checking for a missing audit line proved nothing either way.
    const after = await db.emailOutbox.count({ where: { orderId: 'o_outbox' } })
    expect(after).toBe(before + 1)
  })
})
