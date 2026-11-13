import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { pool, rows } from './db'
import {
  accessibleOrder,
  acceptPayment,
  completeOrder,
  newOrder,
  withdraw,
  refundFailedOrder,
  cancelOrder,
  paymentInfo,
  quote as createQuote,
  products,
} from './services'
import { id, encrypt } from './crypto'
import { demoSession } from '../lib'
import { analyticsVisitor, recordView } from './funnel'
import { authorize, permissionsFor } from './rbac'
import type { Order, User } from '../types'
import { integration, saveIntegration } from './integrations/config'
import {
  exchangeRate,
  exchangeSources,
  refreshExchangeRate,
  requestExchangeRefresh,
} from './exchange-rates'
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('PostgreSQL payment, wallet and authorization invariants', () => {
  let user: User, inviter: User
  const browser = 'test-browser'
  async function fixtureUser(email: string, invitedBy?: string) {
    return (
      await rows<User>(
        'INSERT INTO users(id,email,referral_code,invited_by) VALUES($1,$2,$3,$4) RETURNING *',
        [id('u_'), email, id().slice(0, 10), invitedBy ?? null],
      )
    )[0]
  }
  async function quote(email = `${user.id}@recharge.example.com`) {
    const key = id('q_')
    await pool.query(
      "INSERT INTO quotes(id,browser_digest,product_id,email,amount,expires_at) VALUES($1,$2,'test-plus',$3,6000,now()+interval '15 minutes')",
      [key, browser, email],
    )
    return key
  }
  async function topup(amount = 10000) {
    return newOrder(user, browser, { amount, channel: 'alipay', requestKey: id() })
  }
  async function fundedBuyer(amount = 4000) {
    const buyer = await fixtureUser(`${id()}@example.com`)
    const order = await newOrder(buyer, browser, { amount, channel: 'alipay', requestKey: id() })
    await acceptPayment('xorpay', null, {
      orderId: order.id,
      transactionId: id(),
      amount,
      paid: true,
    })
    return buyer
  }
  beforeAll(async () => {
    const db = new URL(process.env.TEST_DATABASE_URL!).pathname
    if (!db.endsWith('_test'))
      throw new Error('Integration tests require a dedicated database ending in _test')
    await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
    await pool.query(
      "INSERT INTO products(id,name,subtitle,description,price,features,plan) VALUES('test-plus','Test Plus','','',6000,'[]','plus') ON CONFLICT DO NOTHING",
    )
    await pool.query(
      `INSERT INTO settings(id,body) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      [
        JSON.stringify({
          rateBps: 500,
          settlementDays: 0,
          minimumWithdrawal: 100,
          firstOrderOnly: true,
          supportEmail: '',
          alipay: true,
          wechat: true,
          crypto: true,
          fiatProvider: 'xorpay',
        }),
      ],
    )
    inviter = await fixtureUser(`${id()}@example.com`)
    user = await fixtureUser(`${id()}@example.com`, inviter.id)
  })
  afterAll(async () => {
    await pool.end()
  })
  it('preserves accepted service terms and records only one authoritative event per order stage', async () => {
    const buyer = await fixtureUser(`${id()}@example.com`)
    const productId = id('metrics_')
    await pool.query(
      "INSERT INTO products(id,name,subtitle,description,price,features,plan,service_terms) VALUES($1,'Metrics test','','',6000,'[]','plus','已确认的演示服务说明')",
      [productId],
    )
    const visitor = id('browser_')
    await recordView(visitor, 'checkout_view', productId, 'google')
    await recordView(visitor, 'checkout_view', productId, 'google')
    const q = await createQuote(productId, demoSession('metrics@example.com'), visitor, {
      source: 'google',
      analytics: true,
    })
    await pool.query("UPDATE products SET service_terms='后续变更' WHERE id=$1", [productId])
    const order = await newOrder(buyer, visitor, {
      quoteId: q.id,
      channel: 'alipay',
      requestKey: id(),
    })
    expect(q.serviceTerms).toBe('已确认的演示服务说明')
    expect(order.serviceTerms).toBe(q.serviceTerms)
    const receipt = { orderId: order.id, transactionId: id(), amount: order.amount, paid: true }
    await acceptPayment('xorpay', null, receipt)
    await acceptPayment('xorpay', null, receipt)
    await completeOrder(order.id)
    await completeOrder(order.id)
    const events = (
      await pool.query(
        'SELECT event,source,count(*)::int AS n FROM funnel_events WHERE visitor_key=$1 GROUP BY event,source',
        [analyticsVisitor(visitor)],
      )
    ).rows
    expect(events.map((e) => e.event).sort()).toEqual(
      [
        'checkout_view',
        'quote_ready',
        'order_created',
        'payment_succeeded',
        'delivery_completed',
      ].sort(),
    )
    expect(events.every((e) => e.n === 1 && e.source === 'google')).toBe(true)
    const privateQuote = await createQuote(productId, demoSession('private@example.com'), visitor)
    expect(
      (await pool.query('SELECT analytics_visitor FROM quotes WHERE id=$1', [privateQuote.id]))
        .rows[0].analytics_visitor,
    ).toBeNull()
  })
  it('isolates guest orders and preserves a separate contact email', async () => {
    const quoteId = await quote('recharge@example.com')
    const input = {
      quoteId,
      channel: 'alipay' as const,
      requestKey: id(),
      contactEmail: `${id()}@example.com`,
    }
    await expect(newOrder(null, browser, { ...input, contactEmail: undefined })).rejects.toThrow(
      '请填写联系邮箱',
    )
    const order = await newOrder(null, browser, input)
    expect(order.userId).toBeNull()
    expect(order.contactEmail).toBe(input.contactEmail)
    expect(order.email).toBe('recharge@example.com')
    expect((await accessibleOrder(null, browser, order.id)).id).toBe(order.id)
    await expect(accessibleOrder(null, 'different-browser', order.id)).rejects.toThrow('未找到订单')
    await expect(
      newOrder(null, browser, { ...input, amount: 10000, quoteId: undefined }),
    ).rejects.toThrow('钱包功能')
    expect((await newOrder(null, browser, input)).id).toBe(order.id)
    await expect(
      newOrder(null, browser, { ...input, contactEmail: 'changed@example.com' }),
    ).rejects.toThrow('参数')
    await acceptPayment('xorpay', null, {
      orderId: order.id,
      transactionId: id(),
      amount: order.amount,
      paid: true,
    })
    await completeOrder(order.id)
    expect((await accessibleOrder(null, browser, order.id)).status).toBe('completed')
    expect(
      (await pool.query('SELECT count(*)::int n FROM email_outbox WHERE order_id=$1', [order.id]))
        .rows[0].n,
    ).toBe(3)
  })
  it('rejects amount, provider and revision substitution before changing state', async () => {
    const o = await topup()
    const receipt = { orderId: o.id, transactionId: id(), amount: o.amount, paid: true }
    await expect(acceptPayment('xorpay', null, { ...receipt, amount: 1 })).rejects.toThrow('不匹配')
    await expect(acceptPayment('epay_v1', null, receipt)).rejects.toThrow('归属')
    await expect(acceptPayment('xorpay', 'other-config', receipt)).rejects.toThrow('归属')
    expect((await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status).toBe(
      'unpaid',
    )
  })
  it('credits a recharge only once under 12 concurrent identical callbacks', async () => {
    const o = await topup()
    const receipt = { orderId: o.id, transactionId: id(), amount: o.amount, paid: true }
    await Promise.all(Array.from({ length: 12 }, () => acceptPayment('xorpay', null, receipt)))
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [user.id])).rows[0].balance,
    ).toBe(10000)
    expect(
      (await pool.query('SELECT count(*)::int n FROM wallet_ledger WHERE order_id=$1', [o.id]))
        .rows[0].n,
    ).toBe(1)
    expect(
      (await pool.query('SELECT count(*)::int n FROM commissions WHERE order_id=$1', [o.id]))
        .rows[0].n,
    ).toBe(0)
    const other = await topup()
    await expect(acceptPayment('xorpay', null, { ...receipt, orderId: other.id })).rejects.toThrow(
      '交易号已用于',
    )
  })
  it('serializes concurrent wallet spending and rolls back insufficient purchases', async () => {
    const q1 = await quote(),
      q2 = await quote()
    const results = await Promise.allSettled([
      newOrder(user, browser, { quoteId: q1, channel: 'balance', requestKey: id() }),
      newOrder(user, browser, { quoteId: q2, channel: 'balance', requestKey: id() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [user.id])).rows[0].balance,
    ).toBe(4000)
    const success = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Order>
    await Promise.all(Array.from({ length: 8 }, () => completeOrder(success.value.id)))
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM commissions WHERE order_id=$1', [
          success.value.id,
        ])
      ).rows[0].n,
    ).toBe(1)
    expect(
      (await pool.query('SELECT amount FROM commissions WHERE order_id=$1', [success.value.id]))
        .rows[0].amount,
    ).toBe(300)
  })
  it('never reuses an idempotency key for different monetary parameters', async () => {
    const requestKey = id()
    const first = await newOrder(user, browser, { amount: 100, channel: 'alipay', requestKey })
    const repeat = await newOrder(user, browser, { amount: 100, channel: 'alipay', requestKey })
    expect(first.id).toBe(repeat.id)
    await expect(
      newOrder(user, browser, { amount: 200, channel: 'alipay', requestKey }),
    ).rejects.toThrow('不同的订单参数')
  })
  it('prevents concurrent withdrawals from spending the same commission', async () => {
    await pool.query("UPDATE commissions SET status='available' WHERE user_id=$1", [inviter.id])
    const request = { amount: 300, method: '支付宝', account: 'private-payout-account' }
    const results = await Promise.allSettled([
      withdraw(inviter, { ...request, requestKey: id() }),
      withdraw(inviter, { ...request, requestKey: id() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const stored = (
      await pool.query('SELECT account FROM withdrawals WHERE user_id=$1', [inviter.id])
    ).rows[0]
    expect(stored.account).not.toContain(request.account)
  })
  it('refunds confirmed failed purchases once, never arbitrary unpaid orders', async () => {
    const o = await newOrder(user, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      requestKey: id(),
    })
    await expect(refundFailedOrder(o.id, 'test')).rejects.toThrow('仅已确认失败')
    await acceptPayment('xorpay', null, {
      orderId: o.id,
      transactionId: id(),
      amount: o.amount,
      paid: true,
    })
    await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [o.id])
    await Promise.all([refundFailedOrder(o.id, 'test'), refundFailedOrder(o.id, 'test')])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM wallet_ledger WHERE order_id=$1 AND kind='refund'",
          [o.id],
        )
      ).rows[0].n,
    ).toBe(1)
  })
  it('enforces roles on the server and changes permissions immediately', async () => {
    const roleId = id('role_')
    await pool.query('INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3)', [
      roleId,
      'Support',
      JSON.stringify(['admin:access', 'orders:read']),
    ])
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [user.id, roleId])
    const permissions = await permissionsFor(user)
    expect(() => authorize({ ...user, permissions }, 'orders:read')).not.toThrow()
    expect(() => authorize({ ...user, permissions }, 'integrations:write')).toThrow()
    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [user.id])
    expect(await permissionsFor(user)).toEqual([])
  })
  it('locks upgrade retail prices in expiring server quotes instead of trusting later catalog prices', async () => {
    await pool.query(
      "INSERT INTO products(id,name,subtitle,description,price,features,plan,upgrade,pricing_mode) VALUES('test-upgrade','Upgrade','','',1,'[]','promax',true,'markup') ON CONFLICT DO NOTHING",
    )
    const previous = (await pool.query('SELECT body FROM settings WHERE id=1')).rows[0].body
    try {
      await pool.query(
        `UPDATE settings SET body=body||'{"upgradePricing":{"fxMode":"manual","fxRateBps":70000,"markupBps":1000,"serviceFee":500,"minimum":100,"targets":{"promax":{"markupBps":2000,"serviceFee":500,"minimumProfit":2000}}}}'::jsonb WHERE id=1`,
      )
      const priced = await createQuote(
        'test-upgrade',
        JSON.stringify({
          user: { email: `${id()}@example.com` },
          accessToken: 'demo',
          sessionToken: 'demo',
        }),
        browser,
      )
      expect(priced.amount).toBe(9000)
      expect(priced.targetPlan).toBe('promax')
      await pool.query(
        `UPDATE settings SET body=jsonb_set(body,'{upgradePricing,serviceFee}','90000') WHERE id=1`,
      )
      const order = await newOrder(user, browser, {
        quoteId: priced.id,
        channel: 'alipay',
        requestKey: id(),
      })
      expect(order.amount).toBe(9000)
      const snapshot = (
        await pool.query('SELECT pricing_snapshot FROM quotes WHERE id=$1', [priced.id])
      ).rows[0].pricing_snapshot
      expect(snapshot.serviceFee).toBe(500)
      const stale = await quote()
      await pool.query("UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=$1", [
        stale,
      ])
      await expect(
        newOrder(user, browser, { quoteId: stale, channel: 'alipay', requestKey: id() }),
      ).rejects.toThrow('已过期')
    } finally {
      await pool.query('UPDATE settings SET body=$1 WHERE id=1', [JSON.stringify(previous)])
    }
  })
  it('uses exact fixed subscription prices and preserves confirmed quotes after price changes', async () => {
    const productId = id('p_')
    await pool.query(
      "INSERT INTO products(id,name,subtitle,description,price,features,plan,pricing_mode) VALUES($1,'Recharge','','',4937,'[]','go','fixed')",
      [productId],
    )
    const session = JSON.stringify({
      user: { email: `${id()}@example.com` },
      accessToken: 'demo',
      sessionToken: 'demo',
    })
    const fixed = await createQuote(productId, session, browser)
    expect(fixed.amount).toBe(4937)
    expect((await products()).find((p) => p.id === productId)?.price).toBe(4937)
    const snapshot = (
      await pool.query('SELECT pricing_snapshot FROM quotes WHERE id=$1', [fixed.id])
    ).rows[0].pricing_snapshot
    expect(snapshot).toEqual({ mode: 'fixed', price: 4937 })
    await pool.query('UPDATE products SET price=5279 WHERE id=$1', [productId])
    expect((await createQuote(productId, session, browser)).amount).toBe(5279)
    const order = await newOrder(user, browser, {
      quoteId: fixed.id,
      channel: 'alipay',
      requestKey: id(),
    })
    expect(order.amount).toBe(4937)
    await expect(
      pool.query("UPDATE products SET pricing_mode='markup' WHERE id=$1", [productId]),
    ).rejects.toThrow()
    await expect(
      pool.query('UPDATE products SET upgrade=true WHERE id=$1', [productId]),
    ).rejects.toThrow()
  })
  it('refreshes FX once in the background, serves cached retail prices and preserves locked quote amounts', async () => {
    const productId = id('usd_')
    await pool.query(
      "INSERT INTO products(id,name,subtitle,description,price,features,plan,price_currency,rounding_step) VALUES($1,'USD','','',2000,'[]','plus','USD',100)",
      [productId],
    )
    await pool.query(
      'UPDATE exchange_rates SET rate_e8=null,source_date=null,fetched_at=null,expires_at=null,locked_until=null,refresh_after=now()',
    )
    const session = JSON.stringify({
      user: { email: `${id()}@example.com` },
      accessToken: 'demo',
      sessionToken: 'demo',
    })
    const sourceDate = new Date().toISOString().slice(0, 10)
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ date: sourceDate, usd: { cny: 7.12345678 } })),
    )
    vi.stubGlobal('fetch', fetcher)
    try {
      await expect(createQuote(productId, session, browser)).rejects.toThrow('汇率正在更新')
      expect(fetcher).not.toHaveBeenCalled()
      await Promise.all(Array.from({ length: 8 }, () => refreshExchangeRate()))
      expect(fetcher).toHaveBeenCalledTimes(1)
      const before = await exchangeRate(true)
      const locked = await createQuote(productId, session, browser)
      expect(locked.amount).toBe(14300)
      const catalog = (await products()).find((p) => p.id === productId)!
      expect(catalog.price).toBe(14300)
      expect(catalog.priceCurrency).toBe('CNY')
      expect((await products(true)).find((p) => p.id === productId)?.price).toBe(2000)
      await Promise.all(Array.from({ length: 5 }, () => createQuote(productId, session, browser)))
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await exchangeRate(true)).toEqual(before)
      fetcher.mockRejectedValue(new Error('private transport failure'))
      await requestExchangeRefresh()
      await refreshExchangeRate()
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(await exchangeRate(true)).toEqual(before)
      expect((await createQuote(productId, session, browser)).amount).toBe(14300)
      await pool.query("UPDATE exchange_rates SET expires_at=now()-interval '1 second'")
      await expect(createQuote(productId, session, browser)).rejects.toThrow('汇率正在更新')
      expect((await products()).find((p) => p.id === productId)?.priceStatus).toBe('pending')
      fetcher.mockReset()
      fetcher.mockResolvedValueOnce(new Response('', { status: 503 }))
      fetcher.mockResolvedValueOnce(
        new Response(JSON.stringify({ date: sourceDate, usd: { cny: 8 } })),
      )
      await requestExchangeRefresh()
      await refreshExchangeRate()
      expect(fetcher.mock.calls.map((args) => (args as unknown[])[0])).toEqual([...exchangeSources])
      expect((await createQuote(productId, session, browser)).amount).toBe(16000)
      const order = await newOrder(user, browser, {
        quoteId: locked.id,
        channel: 'alipay',
        requestKey: id(),
      })
      expect(order.amount).toBe(14300)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('selects EPay protocol atomically while preserving historical configuration and isolating secrets', async () => {
    const previous = (await pool.query('SELECT body FROM settings WHERE id=1')).rows[0].body
    try {
      await pool.query(
        `UPDATE settings SET body=body||'{"fiatProvider":"epay_v1"}'::jsonb WHERE id=1`,
      )
      await saveIntegration(
        {
          provider: 'epay_v1',
          enabled: true,
          public: { url: 'https://pay.example.com', pid: '123' },
          secrets: { key: 'test-md5-key' },
        },
        user.email,
      )
      const v1 = await integration('epay_v1')
      await expect(
        saveIntegration(
          {
            provider: 'epay_v2',
            enabled: true,
            public: { url: 'https://pay.example.com', pid: '123' },
            secrets: {},
          },
          user.email,
        ),
      ).rejects.toThrow('完整配置')
      expect(
        (await pool.query('SELECT body FROM settings WHERE id=1')).rows[0].body.epayVersion,
      ).toBe('epay_v1')
      await saveIntegration(
        {
          provider: 'epay_v2',
          enabled: false,
          public: { url: 'https://pay-v2.example.com', pid: '456' },
          secrets: {},
        },
        user.email,
      )
      const switched = (await pool.query('SELECT body FROM settings WHERE id=1')).rows[0].body
      expect(switched.epayVersion).toBe('epay_v2')
      expect(switched.fiatProvider).toBe('epay_v2')
      expect(await integration('epay_v1', v1.id)).toEqual(v1)
      const v2 = (
        await pool.query("SELECT id FROM integrations WHERE provider='epay_v2' AND active=true")
      ).rows[0].id
      expect((await integration('epay_v2', v2)).key).toBeUndefined()
      await saveIntegration(
        {
          provider: 'epay_v1',
          enabled: true,
          public: { url: 'https://pay.example.com', pid: '123' },
          secrets: {},
        },
        user.email,
      )
      expect((await integration('epay_v1')).key).toBe('test-md5-key')
      expect(await integration('epay_v1', v1.id)).toEqual(v1)
    } finally {
      await pool.query('UPDATE settings SET body=$1 WHERE id=1', [JSON.stringify(previous)])
    }
  })
  it('splits payment atomically and accepts only the external amount, then refunds the total once', async () => {
    const buyer = await fundedBuyer()
    const input = {
      quoteId: await quote(`${id()}@recharge.example.com`),
      channel: 'alipay' as const,
      balanceAmount: 4000,
      requestKey: id(),
    }
    const orders = await Promise.all(
      Array.from({ length: 6 }, () => newOrder(buyer, browser, input)),
    )
    const order = orders[0]
    expect(new Set(orders.map((o) => o.id)).size).toBe(1)
    expect(order.balanceAmount).toBe(4000)
    expect(order.externalAmount).toBe(2000)
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [buyer.id])).rows[0]
        .balance,
    ).toBe(0)
    const receipt = { orderId: order.id, transactionId: id(), amount: 2000, paid: true }
    await expect(acceptPayment('xorpay', null, { ...receipt, amount: 6000 })).rejects.toThrow(
      '不匹配',
    )
    await Promise.all(Array.from({ length: 6 }, () => acceptPayment('xorpay', null, receipt)))
    expect(
      (await pool.query('SELECT count(*)::int n FROM jobs WHERE order_id=$1', [order.id])).rows[0]
        .n,
    ).toBe(1)
    await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [order.id])
    await Promise.all([refundFailedOrder(order.id, 'test'), refundFailedOrder(order.id, 'test')])
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [buyer.id])).rows[0]
        .balance,
    ).toBe(6000)
  })
  it('cancels unattempted split payments once and rejects late callbacks or unsafe cancellation', async () => {
    const buyer = await fundedBuyer()
    const order = await newOrder(buyer, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 3000,
      requestKey: id(),
    })
    await expect(cancelOrder(null, 'other-browser', order.id)).rejects.toThrow('未找到')
    await Promise.all([
      cancelOrder(buyer, browser, order.id),
      cancelOrder(buyer, browser, order.id),
    ])
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [buyer.id])).rows[0]
        .balance,
    ).toBe(4000)
    await expect(
      acceptPayment('xorpay', null, {
        orderId: order.id,
        transactionId: id(),
        amount: 3000,
        paid: true,
      }),
    ).rejects.toThrow('状态')
    await expect(paymentInfo(buyer, order.id, '127.0.0.1', browser)).rejects.toThrow('已取消')
    const attempted = await newOrder(buyer, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 3000,
      requestKey: id(),
    })
    await paymentInfo(buyer, attempted.id, '127.0.0.1', browser)
    await expect(cancelOrder(buyer, browser, attempted.id)).rejects.toThrow('不能直接取消')
  })
  it('enforces external payment limits before any wallet debit or order insertion', async () => {
    const buyer = await fundedBuyer()
    await pool.query(
      `UPDATE settings SET body=body||'{"paymentLimits":{"alipay":{"min":1000,"max":3000}}}'::jsonb WHERE id=1`,
    )
    try {
      const quoteId = await quote()
      await expect(
        newOrder(buyer, browser, {
          quoteId,
          channel: 'alipay',
          balanceAmount: 2000,
          requestKey: id(),
        }),
      ).rejects.toThrow('单笔支付范围')
      expect(
        (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [buyer.id])).rows[0]
          .balance,
      ).toBe(4000)
      const order = await newOrder(buyer, browser, {
        quoteId,
        channel: 'alipay',
        balanceAmount: 4000,
        requestKey: id(),
      })
      expect(order.externalAmount).toBe(2000)
      await expect(
        newOrder(buyer, browser, { amount: 500, channel: 'alipay', requestKey: id() }),
      ).rejects.toThrow('单笔支付范围')
    } finally {
      await pool.query("UPDATE settings SET body=body-'paymentLimits' WHERE id=1")
    }
  })
  it('prevents concurrent split orders from overspending and supports full balance offsets', async () => {
    const buyer = await fundedBuyer()
    const results = await Promise.allSettled(
      [await quote(), await quote()].map((quoteId) =>
        newOrder(buyer, browser, {
          quoteId,
          channel: 'wechat',
          balanceAmount: 3000,
          requestKey: id(),
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [buyer.id])).rows[0]
        .balance,
    ).toBe(1000)
    const fullyFunded = await fundedBuyer(6000)
    const full = await newOrder(fullyFunded, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 6000,
      requestKey: id(),
    })
    expect(full.externalAmount).toBe(0)
    expect(full.channel).toBe('balance')
    expect(full.status).toBe('processing')
    await expect(
      newOrder(null, browser, {
        quoteId: await quote(),
        channel: 'alipay',
        balanceAmount: 1,
        requestKey: id(),
        contactEmail: 'guest@example.com',
      }),
    ).rejects.toThrow('钱包功能')
  })
  it('rewards a guest without registration and preserves first-order attribution across concurrent orders and claim', async () => {
    const referralOwner = await fixtureUser(`${id()}@example.com`)
    const guestEmail = `${id()}@guest.example.com`
    const guestRecharge = `${id()}@recharge.example.com`
    const orders = await Promise.all(
      [await quote(guestRecharge), await quote(guestRecharge)].map((quoteId) =>
        newOrder(null, browser, {
          quoteId,
          channel: 'alipay',
          requestKey: id(),
          contactEmail: guestEmail,
          referralCode: referralOwner.referralCode,
        }),
      ),
    )
    for (const order of orders)
      await acceptPayment('xorpay', null, {
        orderId: order.id,
        transactionId: id(),
        amount: 6000,
        paid: true,
      })
    await Promise.all(orders.map((o) => completeOrder(o.id)))
    const commissions = await pool.query('SELECT * FROM commissions WHERE user_id=$1', [
      referralOwner.id,
    ])
    expect(commissions.rows).toHaveLength(1)
    expect(commissions.rows[0].amount).toBe(300)
    const claimed = await fixtureUser(guestEmail)
    await pool.query(
      'UPDATE orders SET user_id=$1,guest_browser_digest=null WHERE contact_email=$2',
      [claimed.id, guestEmail],
    )
    await Promise.all(orders.map((o) => completeOrder(o.id)))
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM commissions WHERE user_id=$1', [
          referralOwner.id,
        ])
      ).rows[0].n,
    ).toBe(1)
    await expect(accessibleOrder(null, browser, orders[0].id)).rejects.toThrow('未找到')
    const self = await newOrder(null, browser, {
      quoteId: await quote(referralOwner.email),
      channel: 'alipay',
      requestKey: id(),
      contactEmail: `${id()}@guest.example.com`,
      referralCode: referralOwner.referralCode,
    })
    await acceptPayment('xorpay', null, {
      orderId: self.id,
      transactionId: id(),
      amount: 6000,
      paid: true,
    })
    await completeOrder(self.id)
    expect(
      (await pool.query('SELECT count(*)::int n FROM commissions WHERE order_id=$1', [self.id]))
        .rows[0].n,
    ).toBe(0)
  })
})
