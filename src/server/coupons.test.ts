import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_coupons_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32)
})

import { db, Prisma } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import {
  account,
  cancelOrder,
  completeOrder,
  newOrder,
  paymentInfo,
  products,
  refundFailedOrder,
} from './services'
import { previewCoupon, releaseExpiredCouponOrders, saveAdminCoupon } from './coupons'
import { userView } from './data'
import { id } from './crypto'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip

suite('coupon reservation, concurrency, upgrade floor, and affiliate attribution', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.setting.create({
      data: {
        id: 1,
        body: {
          rateBps: 500, // 5% default referral rate
          settlementDays: 7,
          firstOrderOnly: false,
          supportEmail: 'support@example.com',
          alipay: true,
          wechat: true,
          crypto: false,
          fiatProvider: 'xorpay',
          emailProvider: 'smtp',
        },
      },
    })
    await db.product.createMany({
      data: [
        {
          id: 'plus',
          name: 'ChatGPT Plus',
          subtitle: '日常主力',
          description: 'Plus 月度充值',
          price: 14500,
          features: ['GPT-5'],
          plan: 'plus',
          enabled: true,
          featured: true,
          upgrade: false,
        },
        {
          id: 'upgrade-pro20',
          name: '升级 Pro 200',
          subtitle: '差价升级',
          description: '按账号剩余订阅折算升级',
          price: 100,
          features: ['Pro 200'],
          plan: 'pro20',
          enabled: true,
          featured: false,
          upgrade: true,
          pricingMode: 'markup',
        },
      ],
    })
  }, 30000)

  afterAll(cleanupTestDatabase)

  async function createTestUser(emailPrefix: string) {
    const record = await db.user.create({
      data: {
        id: id('u_'),
        email: `${emailPrefix}-${id()}@example.com`,
        referralCode: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
      },
    })
    await db.wallet.create({ data: { userId: record.id, balance: 50000 } })
    return userView(record)
  }

  async function createQuoteFixture(options: {
    browser: string
    productId?: string
    email?: string
    amount?: number
    targetPlan?: string
    pricingSnapshot?: Record<string, unknown>
  }) {
    const productId = options.productId ?? 'plus'
    const quote = await db.quote.create({
      data: {
        id: id('q_'),
        browserDigest: options.browser,
        productId,
        email: (options.email ?? `target-${id()}@example.com`).toLowerCase(),
        amount: options.amount ?? 14500,
        expiresAt: new Date(Date.now() + 8 * 60_000),
        targetPlan: options.targetPlan ?? (productId === 'upgrade-pro20' ? 'pro20' : 'plus'),
        pricingSnapshot: options.pricingSnapshot
          ? (options.pricingSnapshot as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    })
    return quote
  }

  async function createCoupon(data: Record<string, unknown>) {
    const res = await saveAdminCoupon('admin@example.com', data, async () => {})
    return res.coupon
  }

  it('prevents overselling under concurrent requests on maxRedemptions = 1 and preserves idempotent retry', async () => {
    const coupon = await createCoupon({
      code: 'FLASH1',
      name: '限量 1 张秒杀券',
      discountKind: 'fixed',
      discountValue: 3000,
      scopeMode: 'all',
      maxRedemptions: 1,
      perBuyerLimit: 1,
      enabled: true,
    })

    const attempts = await Promise.all(
      Array.from({ length: 6 }, async (_, idx) => {
        const browser = `browser_race_${idx}_${id()}`
        const quote = await createQuoteFixture({ browser })
        const requestKey = `rk_race_${idx}_${id()}`
        return newOrder(
          null,
          browser,
          {
            quoteId: quote.id,
            channel: 'alipay',
            requestKey,
            contactEmail: `buyer${idx}-${id()}@example.com`,
            couponCode: 'flash1',
          },
          `198.51.100.${10 + idx}`,
        ).then(
          (order) => ({ ok: true as const, order, browser, quoteId: quote.id, requestKey }),
          (error: Error) => ({ ok: false as const, message: error.message }),
        )
      }),
    )

    const winners = attempts.filter((r) => r.ok)
    const losers = attempts.filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(5)
    for (const loser of losers) {
      if (!loser.ok) expect(loser.message).toContain('此优惠码名额已领完')
    }

    const winner = winners[0]!
    if (!winner.ok) throw new Error('expected winner')
    expect(winner.order).toMatchObject({
      listAmount: 14500,
      discountAmount: 3000,
      amount: 11500,
      couponCode: 'FLASH1',
    })

    // Idempotent retry of the winning requestKey returns the existing order instead of failing with quota exhausted
    const replayed = await newOrder(null, winner.browser, {
      quoteId: winner.quoteId,
      channel: 'alipay',
      requestKey: winner.requestKey,
      contactEmail: winner.order.contactEmail,
      couponCode: 'FLASH1',
    })
    expect(replayed.id).toBe(winner.order.id)

    // Cancelling the unpaid order releases the coupon slot for the next buyer
    await cancelOrder(null, winner.browser, winner.order.id)
    const released = await db.couponRedemption.findUniqueOrThrow({
      where: { orderId: winner.order.id },
    })
    expect(released.status).toBe('released')

    const nextBrowser = `browser_after_cancel_${id()}`
    const nextQuote = await createQuoteFixture({ browser: nextBrowser })
    const nextOrder = await newOrder(null, nextBrowser, {
      quoteId: nextQuote.id,
      channel: 'alipay',
      requestKey: `rk_next_${id()}`,
      contactEmail: `next-${id()}@example.com`,
      couponCode: coupon.code,
    })
    expect(nextOrder.amount).toBe(11500)
  })

  it('auto-releases expired unpaid coupon reservations unless paymentAttempted is true', async () => {
    const coupon = await createCoupon({
      code: 'EXPIRE_LOCK',
      name: '超时释放测试券',
      discountKind: 'fixed',
      discountValue: 2000,
      maxRedemptions: 2,
      enabled: true,
    })

    // Order A: unpaid, no paymentAttempted, expired reservation -> should be cancelled & released
    const browserA = `browser_exp_a_${id()}`
    const quoteA = await createQuoteFixture({ browser: browserA })
    const orderA = await newOrder(null, browserA, {
      quoteId: quoteA.id,
      channel: 'alipay',
      requestKey: `rk_a_${id()}`,
      contactEmail: `exp-a-${id()}@example.com`,
      couponCode: coupon.code,
    })

    // Order B: unpaid, paymentInfo called (paymentAttempted = true) -> should NOT be auto-cancelled
    const browserB = `browser_exp_b_${id()}`
    const quoteB = await createQuoteFixture({ browser: browserB })
    const orderB = await newOrder(null, browserB, {
      quoteId: quoteB.id,
      channel: 'alipay',
      requestKey: `rk_b_${id()}`,
      contactEmail: `exp-b-${id()}@example.com`,
      couponCode: coupon.code,
    })
    await paymentInfo(null, orderB.id, '198.51.100.88', browserB)

    // Force Order A's redemption expiresAt into the past
    await db.couponRedemption.update({
      where: { orderId: orderA.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    await releaseExpiredCouponOrders(coupon.id)

    const refreshedA = await db.order.findUniqueOrThrow({ where: { id: orderA.id } })
    const redemptionA = await db.couponRedemption.findUniqueOrThrow({
      where: { orderId: orderA.id },
    })
    expect(refreshedA.status).toBe('cancelled')
    expect(redemptionA.status).toBe('released')

    const refreshedB = await db.order.findUniqueOrThrow({ where: { id: orderB.id } })
    const redemptionB = await db.couponRedemption.findUniqueOrThrow({
      where: { orderId: orderB.id },
    })
    expect(refreshedB.status).toBe('unpaid')
    expect(redemptionB.status).toBe('reserved')
    expect(redemptionB.expiresAt).toBeNull()
  })

  it('enforces perBuyerLimit across target ChatGPT account, requireLogin, firstOrderOnly, and blocks wallet topup coupons', async () => {
    const user = await createTestUser('buyer')
    // Wallet topup strictly rejects couponCode
    await expect(
      newOrder(user, 'browser_topup', {
        amount: 10000,
        channel: 'alipay',
        requestKey: `rk_topup_${id()}`,
        couponCode: 'ANYCODE',
      }),
    ).rejects.toThrow('钱包充值不支持使用优惠码')

    await createCoupon({
      code: 'LOGIN_FIRST',
      name: '登录首单限1次券',
      discountKind: 'fixed',
      discountValue: 2500,
      requireLogin: true,
      firstOrderOnly: true,
      perBuyerLimit: 1,
      enabled: true,
    })

    const sharedTargetEmail = `shared-gpt-${id()}@example.com`
    const guestBrowser = `browser_guest_${id()}`
    const guestQuote = await createQuoteFixture({
      browser: guestBrowser,
      email: sharedTargetEmail,
    })

    // Guest preview shows valid catalog preview, but quote preview marks requireLogin ineligible
    const catalogList = await products()
    const guestPreview = await previewCoupon(
      { code: 'LOGIN_FIRST', quoteId: guestQuote.id },
      null,
      guestBrowser,
      catalogList,
    )
    expect(guestPreview.valid).toBe(true)
    expect(guestPreview.quote?.eligible).toBe(false)
    expect(guestPreview.quote?.reason).toContain('登录')

    await expect(
      newOrder(null, guestBrowser, {
        quoteId: guestQuote.id,
        channel: 'alipay',
        requestKey: `rk_guest_${id()}`,
        contactEmail: `guest-${id()}@example.com`,
        couponCode: 'LOGIN_FIRST',
      }),
    ).rejects.toThrow('此优惠码需要先登录后使用')

    // Logged-in user succeeds on first order (paid via wallet balance)
    const userBrowser = `browser_user_${id()}`
    const userQuote = await createQuoteFixture({
      browser: userBrowser,
      email: sharedTargetEmail,
    })
    const firstOrder = await newOrder(user, userBrowser, {
      quoteId: userQuote.id,
      channel: 'balance',
      requestKey: `rk_first_${id()}`,
      couponCode: 'LOGIN_FIRST',
    })
    expect(firstOrder.amount).toBe(12000)
    await completeOrder(firstOrder.id)

    // Another user trying to recharge the SAME ChatGPT target email is blocked by perBuyerLimit / firstOrderOnly
    const user2 = await createTestUser('buyer2')
    const user2Browser = `browser_user2_${id()}`
    const user2Quote = await createQuoteFixture({
      browser: user2Browser,
      email: sharedTargetEmail,
    })
    await expect(
      newOrder(user2, user2Browser, {
        quoteId: user2Quote.id,
        channel: 'alipay',
        requestKey: `rk_second_${id()}`,
        couponCode: 'LOGIN_FIRST',
      }),
    ).rejects.toThrow(/限用|首单|已使用/)
  })

  it('caps upgrade discounts at upstream cost floor during order creation', async () => {
    await createCoupon({
      code: 'UPG_BIG',
      name: '升级大额券（保本）',
      discountKind: 'fixed',
      discountValue: 15000, // ¥150 off
      scopeMode: 'upgrade_only',
      upgradeProtection: 'cost',
      enabled: true,
    })

    // Upstream $80 * 7.2000 = ¥576.00 (57600 fen) cost, quote price = ¥650.00 (65000 fen)
    // Max allowed discount under 'cost' protection = 65000 - 57600 = 7400 fen (¥74.00)
    const browser = `browser_upg_${id()}`
    const quote = await createQuoteFixture({
      browser,
      productId: 'upgrade-pro20',
      amount: 65000,
      targetPlan: 'pro20',
      pricingSnapshot: {
        mode: 'markup',
        fxRateBps: 72000,
        minimumProfit: 1500,
        providerQuote: { amount_minor: 8000, currency_decimals: 2 },
      },
    })

    const order = await newOrder(null, browser, {
      quoteId: quote.id,
      channel: 'alipay',
      requestKey: `rk_upg_${id()}`,
      contactEmail: `upg-${id()}@example.com`,
      couponCode: 'UPG_BIG',
    })
    expect(order.listAmount).toBe(65000)
    expect(order.discountAmount).toBe(7400)
    expect(order.amount).toBe(57600)
  })

  it('coordinates allowReferral, affiliate exclusive attribution, self-use block, and refund reversal', async () => {
    const inviter = await createTestUser('inviter')
    const kol = await createTestUser('kol')
    const buyer = await createTestUser('kolbuyer')

    // 1. Marketing coupon with allowReferral: false suppresses ?ref= commission
    await createCoupon({
      code: 'NO_REF_STACK',
      name: '不叠返现大促券',
      discountKind: 'fixed',
      discountValue: 4500,
      allowReferral: false,
      enabled: true,
    })
    const browser1 = `browser_noref_${id()}`
    const quote1 = await createQuoteFixture({ browser: browser1 })
    const order1 = await newOrder(null, browser1, {
      quoteId: quote1.id,
      channel: 'alipay',
      requestKey: `rk_noref_${id()}`,
      contactEmail: `noref-${id()}@example.com`,
      referralCode: inviter.referralCode,
      couponCode: 'NO_REF_STACK',
    })
    await db.order.update({ where: { id: order1.id }, data: { status: 'processing' } })
    await completeOrder(order1.id)
    expect(await db.commission.count({ where: { orderId: order1.id } })).toBe(0)

    // 2. Marketing coupon with allowReferral: true computes ?ref= commission on post-discount paid amount
    await createCoupon({
      code: 'STACK_OK',
      name: '可叠返现券',
      discountKind: 'fixed',
      discountValue: 4500, // 14500 - 4500 = 10000 fen (¥100.00)
      allowReferral: true,
      enabled: true,
    })
    const browser2 = `browser_stack_${id()}`
    const quote2 = await createQuoteFixture({ browser: browser2 })
    const order2 = await newOrder(null, browser2, {
      quoteId: quote2.id,
      channel: 'alipay',
      requestKey: `rk_stack_${id()}`,
      contactEmail: `stack-${id()}@example.com`,
      referralCode: inviter.referralCode,
      couponCode: 'STACK_OK',
    })
    await db.order.update({ where: { id: order2.id }, data: { status: 'processing' } })
    await completeOrder(order2.id)
    const inviterComm = await db.commission.findUniqueOrThrow({ where: { orderId: order2.id } })
    // Starter tier 3% (300 bps) of ¥100.00 (10000 fen) = 300 fen (NOT 3% of 14500 = 435 fen)
    expect(inviterComm.userId).toBe(inviter.id)
    expect(inviterComm.amount).toBe(300)

    // 3. Affiliate exclusive coupon: attributes to KOL at 8% (800 bps) WITHOUT ?ref=, blocks KOL self-use, shows in account()
    await createCoupon({
      code: 'KOL_888',
      name: 'KOL 专属粉丝券',
      discountKind: 'fixed',
      discountValue: 2500, // 14500 - 2500 = 12000 fen
      affiliateEmail: kol.email,
      affiliateRateBps: 800, // 8%
      enabled: true,
    })

    // Self-use blocked when KOL is logged in
    const kolBrowser = `browser_kol_self_${id()}`
    const kolQuote = await createQuoteFixture({ browser: kolBrowser })
    await expect(
      newOrder(kol, kolBrowser, {
        quoteId: kolQuote.id,
        channel: 'balance',
        requestKey: `rk_kol_self_${id()}`,
        couponCode: 'KOL_888',
      }),
    ).rejects.toThrow('不能使用自己的专属推广优惠码')

    // Buyer uses KOL_888 without any referralCode -> KOL gets 8% of 12000 = 960 fen
    const buyerBrowser = `browser_kol_buyer_${id()}`
    const buyerQuote = await createQuoteFixture({ browser: buyerBrowser })
    const kolOrder = await newOrder(buyer, buyerBrowser, {
      quoteId: buyerQuote.id,
      channel: 'balance',
      requestKey: `rk_kol_buy_${id()}`,
      couponCode: 'KOL_888',
    })
    expect(kolOrder.amount).toBe(12000)
    await completeOrder(kolOrder.id)

    const kolComm = await db.commission.findUniqueOrThrow({ where: { orderId: kolOrder.id } })
    expect(kolComm.userId).toBe(kol.id)
    expect(kolComm.amount).toBe(960)

    const kolAccount = await account(kol)
    expect(kolAccount.affiliateCoupons).toEqual([
      expect.objectContaining({
        code: 'KOL_888',
        affiliateRateBps: 800,
        redeemedCount: 1,
      }),
    ])

    // Refunding a failed coupon order releases the coupon redemption slot and reverses commission
    await db.order.update({ where: { id: kolOrder.id }, data: { status: 'failed' } })
    await refundFailedOrder(kolOrder.id, 'admin@example.com', {
      destination: 'wallet',
      automatic: false,
      note: '测试失败退回钱包并释放优惠券记录',
    })
    const kolRedemption = await db.couponRedemption.findUniqueOrThrow({
      where: { orderId: kolOrder.id },
    })
    expect(kolRedemption.status).toBe('released')
    const reversedComm = await db.commission.findUniqueOrThrow({
      where: { orderId: kolOrder.id },
    })
    expect(reversedComm.status).toBe('reversed')
  })
})
