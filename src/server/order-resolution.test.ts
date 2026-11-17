import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_resolution_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { db } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { seedDatabase } from '../../scripts/seed'
import { id } from './crypto'
import { adminOrderView, orderView, paymentOrderView, userView } from './data'
import { resolveOrder } from './order-resolution'
import { refundFailedOrder, adminData } from './services'
import { sealCredential } from './credential-storage'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('manual fulfillment decisions', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.$transaction(seedDatabase)
  }, 30000)
  afterAll(cleanupTestDatabase)

  async function fixture() {
    const inviter = await db.user.create({
      data: { id: id(), email: `${id()}@example.com`, referralCode: id() },
    })
    const buyer = await db.user.create({
      data: { id: id(), email: `${id()}@example.com`, referralCode: id(), invitedBy: inviter.id },
    })
    await db.wallet.create({ data: { userId: buyer.id, balance: 0 } })
    const inventory = await db.inventory.create({
      data: {
        id: id(),
        productId: 'plus',
        code: 'encrypted-test-card',
        fingerprint: id(),
        status: 'reserved',
      },
    })
    const quoteId = id()
    const quote = await db.quote.create({
      data: {
        id: quoteId,
        productId: 'plus',
        inventoryId: inventory.id,
        browserDigest: 'test-browser',
        email: buyer.email,
        amount: 10000,
        expiresAt: new Date(Date.now() + 600000),
        preflightToken: sealCredential('test-ticket', 'preflight', quoteId),
      },
    })
    const order = await db.order.create({
      data: {
        id: id(),
        userId: buyer.id,
        quoteId,
        productId: 'plus',
        productName: 'Manual resolution fixture',
        email: buyer.email,
        contactEmail: buyer.email,
        listAmount: quote.amount,
        amount: quote.amount,
        balanceAmount: quote.amount,
        externalAmount: 0,
        status: 'processing',
        fulfillmentStatus: 'uncertain',
        submissionAttempted: true,
        channel: 'balance',
        provider: 'balance',
        inviterId: inviter.id,
        rateBps: 300,
        settlementDays: 7,
        firstOrderOnly: true,
      },
    })
    await db.job.create({
      data: {
        id: id(),
        orderId: order.id,
        lease: 'old-worker',
        lockedUntil: new Date(Date.now() + 120000),
      },
    })
    return { order, inventory, buyer }
  }
  const input = (order: Parameters<typeof adminOrderView>[0], outcome: 'completed' | 'failed') => ({
    outcome,
    note: '上游工单 ticket-123 已确认实际结果',
    expectedRevision: adminOrderView(order).resolutionRevision,
    confirmed: true,
  })

  it('settles success, inventory, commission, notifications and audit exactly once', async () => {
    const { order, inventory } = await fixture()
    await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveOrder(order.id, 'operator', input(order, 'completed')),
      ),
    )
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('completed')
    expect(stored.completedAt).toBeInstanceOf(Date)
    expect(adminOrderView(stored).fulfillmentResolution).toMatchObject({
      outcome: 'completed',
      actor: 'operator',
      previousStatus: 'processing',
      previousFulfillmentStatus: 'uncertain',
      note: input(order, 'completed').note,
    })
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inventory.id } })).status).toBe(
      'consumed',
    )
    expect(
      (await db.quote.findUniqueOrThrow({ where: { id: order.quoteId! } })).preflightToken,
    ).toBeNull()
    expect(await db.commission.findMany({ where: { orderId: order.id } })).toMatchObject([
      { amount: 300, status: 'pending' },
    ])
    expect(await db.emailOutbox.count({ where: { orderId: order.id, status: 'completed' } })).toBe(
      1,
    )
    expect(await db.audit.count({ where: { target: order.id, action: '人工确认兑换成功' } })).toBe(
      1,
    )
    expect(await db.job.findUnique({ where: { orderId: order.id } })).toMatchObject({
      done: true,
      lease: null,
      lockedUntil: null,
    })
    for (const publicOrder of [orderView(stored), paymentOrderView(stored)]) {
      expect(publicOrder).not.toHaveProperty('fulfillmentResolution')
      expect(JSON.stringify(publicOrder)).not.toContain('ticket-123')
      expect(JSON.stringify(publicOrder)).not.toContain('operator')
    }
  })

  it('records failure without refunding or releasing inventory, and retains notes after refund', async () => {
    const { order, inventory, buyer } = await fixture()
    await db.order.update({ where: { id: order.id }, data: { status: 'needs_session' } })
    const current = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    await resolveOrder(order.id, 'operator', input(current, 'failed'))
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).balance).toBe(0)
    expect(await db.commission.count({ where: { orderId: order.id } })).toBe(0)
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inventory.id } })).status).toBe(
      'reserved',
    )
    await refundFailedOrder(order.id, 'finance')
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('refunded')
    expect(adminOrderView(stored).fulfillmentResolution?.outcome).toBe('failed')
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).balance).toBe(
      order.amount,
    )
  })

  it('rejects missing evidence, missing confirmation and changed upstream state', async () => {
    const { order } = await fixture()
    const valid = input(order, 'failed')
    await expect(resolveOrder(order.id, 'operator', { ...valid, note: '  ' })).rejects.toThrow(
      '核对依据',
    )
    await expect(
      resolveOrder(order.id, 'operator', { ...valid, confirmed: false }),
    ).rejects.toThrow('确认')
    await db.order.update({ where: { id: order.id }, data: { redemptionVersion: 2 } })
    await expect(resolveOrder(order.id, 'operator', valid)).rejects.toThrow('状态已更新')
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentResolution,
    ).toBeNull()
  })

  it('rejects unpaid, terminal and wallet topup orders', async () => {
    const { order } = await fixture()
    for (const status of ['unpaid', 'completed', 'failed', 'refunded', 'cancelled']) {
      const current = await db.order.update({ where: { id: order.id }, data: { status } })
      await expect(resolveOrder(order.id, 'operator', input(current, 'failed'))).rejects.toThrow(
        '仅处理中',
      )
    }
    const topup = await db.order.update({
      where: { id: order.id },
      data: { status: 'processing', kind: 'topup' },
    })
    await expect(resolveOrder(order.id, 'operator', input(topup, 'completed'))).rejects.toThrow(
      '套餐订单',
    )
  })

  it('serializes competing decisions and never overwrites the accepted outcome', async () => {
    const { order } = await fixture()
    const results = await Promise.allSettled([
      resolveOrder(order.id, 'operator-a', input(order, 'completed')),
      resolveOrder(order.id, 'operator-b', input(order, 'failed')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await db.audit.count({ where: { target: order.id } })).toBe(1)
  })

  it('counts completed orders with conflicting upstream results as needing attention', async () => {
    const { order, buyer } = await fixture()
    await resolveOrder(order.id, 'operator', input(order, 'completed'))
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    const resolution = adminOrderView(stored).fulfillmentResolution!
    const actor = { ...userView(buyer), permissions: ['admin:access', 'orders:read'] }
    const before = (await adminData(actor)).overview!.attentionOrderCount!
    await db.order.update({
      where: { id: order.id },
      data: {
        fulfillmentResolution: {
          ...resolution,
          conflict: {
            status: 'failed',
            redemptionId: 'remote',
            version: 2,
            detectedAt: new Date().toISOString(),
          },
        },
      },
    })
    expect((await adminData(actor)).overview!.attentionOrderCount).toBe(before + 1)
  })
})
