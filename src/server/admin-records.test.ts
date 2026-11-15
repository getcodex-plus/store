import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_admin_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { db } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { seedDatabase } from '../../scripts/seed'
import { adminData } from './services'
import { adminQuerySchema } from './admin-query'
import { userView } from './data'
import { permissions } from './rbac'
import { encrypt } from './crypto'
import type { User } from '../types'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('admin history pagination and permission boundaries', () => {
  let owner: User
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.$transaction(seedDatabase)
    await db.user.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `history-user-${i}`,
        email: `history-${i}@example.com`,
        referralCode: `h${String(i).padStart(9, '0')}`,
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000),
      })),
    })
    owner = {
      ...userView(await db.user.findUniqueOrThrow({ where: { id: 'history-user-0' } })),
      permissions: [...permissions],
    }
    await db.order.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `history-order-${i}`,
        productName: 'History plan',
        email: `recharge-${i}@example.com`,
        contactEmail: `contact-${i}@example.com`,
        ipAddress: i === 0 ? '192.0.2.10' : null,
        amount: 100,
        externalAmount: 100,
        kind: i === 0 ? 'topup' : 'purchase',
        status: i === 1 ? 'refunded' : 'unpaid',
        refundDestination: i === 1 ? 'wallet' : null,
        refundStatus: i === 1 ? 'completed' : null,
        refundActor: i === 1 ? owner.email : null,
        refundRequestedAt: i === 1 ? new Date('2020-01-02') : null,
        refundCompletedAt: i === 1 ? new Date('2020-01-02') : null,
        channel: 'alipay',
        provider: 'xorpay',
        rateBps: 0,
        settlementDays: 0,
        firstOrderOnly: false,
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000),
      })),
    })
    await db.withdrawal.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `history-withdrawal-${i}`,
        userId: owner.id,
        amount: 100,
        method: '支付宝',
        account: encrypt('test@example.com', `withdrawal:${owner.id}`),
        requestKey: `history-request-${i}`,
        status: i === 0 ? 'pending' : 'rejected',
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000),
      })),
    })
  }, 30000)
  afterAll(cleanupTestDatabase)

  it('finds old orders by full id and contact email, and paginates without overlap', async () => {
    const query = (input: object) => adminData(owner, adminQuerySchema.parse(input))
    const first = await query({ section: 'orders' })
    const second = await query({ section: 'orders', page: 2 })
    expect(first.pagination).toEqual({ total: 501, page: 1, pageSize: 12 })
    expect(first.orders).toHaveLength(12)
    expect(second.orders).toHaveLength(12)
    expect(second.orders.some((order) => first.orders.some((item) => item.id === order.id))).toBe(
      false,
    )
    const old = await query({ section: 'orders', search: ' CONTACT-0@EXAMPLE.COM ' })
    expect(old.orders.map((order) => order.id)).toEqual(['history-order-0'])
    const byIP = await query({ section: 'orders', search: '192.0.2.10' })
    expect(byIP.orders.map((order) => order.id)).toEqual(['history-order-0'])
    expect(byIP.orders[0].ipAddress).toBe('192.0.2.10')
    const last = await query({ section: 'orders', page: 42 })
    expect(last.orders).toHaveLength(9)
    expect(last.orders.at(-1)?.id).toBe('history-order-0')
  })

  it('finds older users and wallet orders, and counts pending withdrawals outside the recent window', async () => {
    const users = await adminData(
      owner,
      adminQuerySchema.parse({ section: 'users', search: 'HISTORY-0@EXAMPLE.COM' }),
    )
    expect(users.users.map((user) => user.id)).toEqual([owner.id])
    const wallet = await adminData(owner, adminQuerySchema.parse({ section: 'wallet' }))
    expect(wallet.pagination?.total).toBe(2)
    expect(wallet.orders.map((order) => order.id)).toEqual(['history-order-1', 'history-order-0'])
    const withdrawals = await adminData(
      owner,
      adminQuerySchema.parse({ section: 'withdrawals', page: 42 }),
    )
    expect(withdrawals.withdrawals.at(-1)?.status).toBe('pending')
    expect(withdrawals.pendingWithdrawalCount).toBe(1)
    expect(withdrawals.withdrawals.at(-1)?.account).toBe('test@example.com')
    expect(withdrawals.withdrawals.at(-1)).not.toHaveProperty('requestHash')
  })

  it('rejects unauthorized record counts and keeps wallet-only access scoped', async () => {
    const finance = { ...owner, permissions: ['admin:access', 'wallet:read'] }
    await expect(
      adminData(finance, adminQuerySchema.parse({ section: 'orders' })),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      adminData(finance, adminQuerySchema.parse({ section: 'users' })),
    ).rejects.toMatchObject({ status: 403 })
    const wallet = await adminData(finance, adminQuerySchema.parse({ section: 'wallet' }))
    expect(wallet.orders.map((order) => order.id)).toEqual(['history-order-1', 'history-order-0'])
    expect(wallet.users).toEqual([])
    expect(wallet.withdrawals).toEqual([])
    expect(wallet.pendingWithdrawalCount).toBeUndefined()
  })
})
