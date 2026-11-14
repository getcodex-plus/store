import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_history_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
})
import { db } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { accountHistory, accountHistoryQuery } from './account-history'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('customer history remains complete and scoped to its owner', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.user.createMany({
      data: ['customer', 'stranger'].map((id) => ({
        id,
        email: `${id}@example.com`,
        referralCode: `${id}code`,
      })),
    })
    await db.order.createMany({
      data: Array.from({ length: 206 }, (_, index) => ({
        id: `history-${index}`,
        userId: index === 205 ? 'stranger' : 'customer',
        productName: index === 0 ? 'Oldest plan' : 'ChatGPT Plus',
        email: 'recharge@example.com',
        contactEmail: 'contact@example.com',
        amount: 100,
        externalAmount: 100,
        kind: 'purchase',
        status: index === 0 ? 'needs_session' : 'completed',
        channel: 'alipay',
        provider: 'xorpay',
        rateBps: 0,
        settlementDays: 0,
        firstOrderOnly: false,
        createdAt: new Date(Date.UTC(2020, 0, 1) + index * 1000),
      })),
    })
    await db.walletEntry.createMany({
      data: Array.from({ length: 206 }, (_, index) => ({
        id: `ledger-${index}`,
        userId: index === 205 ? 'stranger' : 'customer',
        orderId: `history-${index}`,
        kind: 'refund',
        amount: 100,
        balanceAfter: (index + 1) * 100,
        createdAt: new Date(Date.UTC(2020, 0, 1) + index * 1000),
      })),
    })
  }, 30000)
  afterAll(cleanupTestDatabase)

  it('finds the oldest order beyond the previous 200-record cap and includes required actions', async () => {
    const query = (input: object) =>
      accountHistory('customer', accountHistoryQuery.parse({ kind: 'orders', ...input }))
    const first = await query({})
    expect(first.total).toBe(205)
    expect(first.rows).toHaveLength(8)
    const second = await query({ page: 2 })
    expect(second.rows.some((row) => first.rows.some((other) => other.id === row.id))).toBe(false)
    const old = await query({ search: ' OLDEST PLAN ', status: 'processing' })
    expect(old.rows.map((row) => row.id)).toEqual(['history-0'])
    const last = await query({ page: 1000 })
    expect(last.page).toBe(26)
    expect(last.rows).toHaveLength(5)
    expect(last.rows.at(-1)?.id).toBe('history-0')
    expect((await query({ search: 'history-205' })).total).toBe(0)
  })

  it('paginates the complete ledger without revealing another account', async () => {
    const history = await accountHistory(
      'customer',
      accountHistoryQuery.parse({ kind: 'ledger', page: 26 }),
    )
    expect(history.total).toBe(205)
    expect(history.rows.at(-1)?.id).toBe('ledger-0')
    const stranger = await accountHistory('stranger', accountHistoryQuery.parse({ kind: 'ledger' }))
    expect(stranger.total).toBe(1)
    expect(stranger.rows.map((row) => row.id)).toEqual(['ledger-205'])
  })

  it('rejects invalid pagination and unsupported filters', () => {
    for (const input of [
      { kind: 'orders', page: 0 },
      { kind: 'orders', page: 1.5 },
      { kind: 'users' },
      { kind: 'orders', status: 'anything' },
      { kind: 'orders', search: 'x'.repeat(255) },
    ])
      expect(accountHistoryQuery.safeParse(input).success).toBe(false)
  })
})
