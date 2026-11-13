import { prepareTestDatabase, cleanupTestDatabase, testQuery } from './database-test-support'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32)
  const schema = `test_aicdk_${crypto.randomUUID().replaceAll('-', '')}`
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', schema)
    process.env.DATABASE_URL = url.toString()
  }
})
import { db, Prisma, transaction } from './db'
import { userView, paymentOrderView } from './data'
import { id, encrypt, hash } from './crypto'
import {
  importInventory,
  inventoryFingerprint,
  migrateCredentialStorage,
  openCredential,
  sealCredential,
} from './credential-storage'
import { quote, newOrder, confirmSession, adminData, account } from './services'
import { fulfillOrder } from './fulfillment'
import { saveIntegration } from './integrations/config'
import { permissions } from './rbac'
import type { User } from '../types'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const email = 'recharge@example.com'
const session = JSON.stringify({
  user: { email },
  accessToken: 'synthetic-access-secret',
  sessionToken: 'synthetic-session-secret',
  extra: { account: 'preserved' },
})
const providerQuote = {
  amount_minor: 1000,
  currency: 'USD',
  currency_decimals: 2,
  business: 'upgrade',
  target_plan: 'pro_200',
}
const ready = {
  status: 'ready',
  preflight_token: 'synthetic-preflight-secret',
  account_email: email,
  quote: providerQuote,
}
const accountResult = {
  account_email: email,
  current_plan: 'plus',
  account_status: 'active',
  subscription: {
    purchase: { eligible: true, plans: [{ id: 'plus', eligible: true }] },
    upgrade: { eligible: true, plans: [{ id: 'pro_200', eligible: true, quote: providerQuote }] },
  },
}
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data }), { status })

suite('AICDK v2 end-to-end business invariants in isolated PostgreSQL schema', () => {
  let user: User
  const browser = 'contract-test-browser'
  let stockCounter = 0
  beforeAll(async () => {
    if (!new URL(process.env.TEST_DATABASE_URL!).pathname.endsWith('_test'))
      throw new Error('Dedicated _test database required')
    await prepareTestDatabase()
    await testQuery(Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan,upgrade,pricing_mode)
      VALUES('upgrade','Upgrade','','',100,'[]','pro20',true,'markup'),('plus','Plus','','',12900,'[]','plus',false,'fixed')`)
    await testQuery(
      Prisma.sql`INSERT INTO settings(id,body) VALUES(1,${JSON.stringify({
        rateBps: 300,
        settlementDays: 7,
        minimumWithdrawal: 100,
        firstOrderOnly: true,
        alipay: true,
        wechat: true,
        crypto: true,
        fiatProvider: 'xorpay',
        upgradePricing: {
          configured: true,
          fxMode: 'manual',
          fxRateBps: 70000,
          markupBps: 2500,
          serviceFee: 0,
          minimum: 100,
          targets: {
            pro20: { markupBps: 2500, serviceFee: 0, minimumProfit: 1000, roundingStep: 100 },
          },
        },
      })})`,
    )
    await saveIntegration(
      {
        provider: 'aicdk',
        enabled: true,
        public: { url: 'http://aicdk.internal:8080' },
        secrets: { apiKey: 'synthetic-api-secret' },
      },
      'test',
    )
    user = userView(
      await db.user.create({
        data: { id: id('u_'), email: 'buyer@example.com', referralCode: id().slice(0, 12) },
      }),
    )
    user.permissions = [...permissions]
    await testQuery(Prisma.sql`INSERT INTO wallets(user_id,balance) VALUES(${user.id},1000000)`)
  }, 30_000)
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => {
    await cleanupTestDatabase()
  })
  function stub(check: unknown = accountResult, preflight: unknown = ready) {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/account-checks')) return ok(check)
      if (url.endsWith('/redemptions/previews'))
        return ok({
          redemption_token: 'preview-ticket',
          credential_type: 'chatgpt_session',
          business: 'upgrade',
        })
      if (url.endsWith('/redemptions/preflights')) return ok(preflight)
      if (url.includes('/redemptions?')) return ok([])
      throw new Error('Unexpected test request')
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  async function stockedQuote() {
    stub()
    await importInventory('upgrade', [`synthetic-card-${++stockCounter}-${id()}`], user.email)
    return quote('upgrade', session, browser)
  }
  async function purchase() {
    const q = await stockedQuote()
    const order = await newOrder(user, browser, {
      quoteId: q.id,
      channel: 'balance',
      requestKey: id(),
      session,
    })
    return { order, q }
  }
  const remote = (orderId: string, status = 'queued', version = 1) => ({
    id: `ord_${orderId}`,
    client_request_id: orderId,
    account_email: email,
    quote: providerQuote,
    version,
    status,
  })
  async function internal(orderId: string) {
    return paymentOrderView(await db.order.findUniqueOrThrow({ where: { id: orderId } }))
  }
  it('keeps the order transaction alive during a slow upstream preflight', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    const response = fetcher.getMockImplementation()!
    fetcher.mockImplementationOnce(async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10_500))
      return response(url)
    })
    const order = await newOrder(user, browser, {
      quoteId: q.id,
      channel: 'balance',
      requestKey: id(),
      session,
    })
    expect(order.status).toBe('processing')
    expect(await db.walletEntry.count({ where: { orderId: order.id, kind: 'purchase' } })).toBe(1)
    expect((await db.quote.findUniqueOrThrow({ where: { id: q.id } })).inventoryId).toBeTruthy()
  }, 20_000)
  it('checks and quotes without inventory, and persists no Session or redemption authorization', async () => {
    const fetcher = stub()
    const result = await quote('upgrade', session, browser)
    expect(result.amount).toBe(8800)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toContain('/account-checks')
    const stored = (await testQuery(Prisma.sql`SELECT * FROM quotes WHERE id=${result.id}`)).rows[0]
    expect(stored.inventory_id).toBeNull()
    expect(stored.preflight_token).toBeNull()
    expect(stored.flow_version).toBe(2)
    expect(JSON.stringify(stored)).not.toContain('synthetic-session-secret')
    expect(JSON.stringify(result)).not.toContain('providerQuote')
  })
  it('fails closed for unknown, ineligible, ambiguous and mismatched account results', async () => {
    for (const eligible of [false, null]) {
      stub({
        ...accountResult,
        subscription: {
          ...accountResult.subscription,
          upgrade: {
            eligible: true,
            plans: [
              { id: 'pro_200', eligible },
              { id: 'pro_100', eligible: true },
            ],
          },
        },
      })
      await expect(quote('upgrade', session, browser)).rejects.toThrow()
    }
    stub({ ...accountResult, account_email: 'other@example.com' })
    await expect(quote('upgrade', session, browser)).rejects.toThrow('不匹配')
    stub({
      ...accountResult,
      subscription: {
        ...accountResult.subscription,
        upgrade: {
          eligible: true,
          plans: [
            accountResult.subscription.upgrade.plans[0],
            accountResult.subscription.upgrade.plans[0],
          ],
        },
      },
    })
    await expect(quote('upgrade', session, browser)).rejects.toThrow('暂不可用')
  })
  it('quotes zero-decimal currency through its own cached exchange rate', async () => {
    await testQuery(Prisma.sql`INSERT INTO exchange_rates(id,rate_e8,source_date,fetched_at,expires_at)
      VALUES('JPY_CNY',5000000,to_char(now(),'YYYY-MM-DD'),now(),now()+interval '1 day')`)
    stub({
      ...accountResult,
      subscription: {
        ...accountResult.subscription,
        upgrade: {
          eligible: true,
          plans: [
            {
              id: 'pro_200',
              eligible: true,
              quote: { amount_minor: 1000, currency: 'JPY', currency_decimals: 0 },
            },
          ],
        },
      },
    })
    expect((await quote('upgrade', session, browser)).amount).toBe(6300)
  })
  it('allocates only at order confirmation, serializes concurrent retries and returns no secrets', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    const input = { quoteId: q.id, channel: 'balance' as const, requestKey: id(), session }
    const [a, b] = await Promise.all([
      newOrder(user, browser, input),
      newOrder(user, browser, input),
    ])
    expect(a.id).toBe(b.id)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const stored = (await testQuery(Prisma.sql`SELECT * FROM quotes WHERE id=${q.id}`)).rows[0]
    expect(stored.inventory_id).toBeTruthy()
    expect(openCredential(stored.preflight_token, 'preflight', q.id)).toBe(ready.preflight_token)
    expect(JSON.stringify(a)).not.toContain('synthetic')
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int AS n FROM wallet_ledger WHERE order_id=${a.id}`,
        )
      ).rows[0].n,
    ).toBe(1)
    const admin = await adminData(user)
    expect(JSON.stringify(admin)).not.toContain('synthetic')
    expect(JSON.stringify(await account(user))).not.toContain('synthetic')
  })
  it('rolls back allocation and balance when a card quote costs more than the accepted price', async () => {
    const q = await stockedQuote()
    stub(accountResult, { ...ready, quote: { ...providerQuote, amount_minor: 9000 } })
    const before = (
      await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)
    ).rows[0].balance
    await expect(
      newOrder(user, browser, { quoteId: q.id, channel: 'balance', requestKey: id(), session }),
    ).rejects.toThrow('成本')
    expect(
      (await testQuery(Prisma.sql`SELECT inventory_id FROM quotes WHERE id=${q.id}`)).rows[0]
        .inventory_id,
    ).toBeNull()
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)).rows[0]
        .balance,
    ).toBe(before)
  })
  it('does not touch the upstream card APIs for missing or mismatched confirmation credentials', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    await expect(
      newOrder(user, browser, {
        quoteId: q.id,
        channel: 'balance',
        requestKey: id(),
      }),
    ).rejects.toThrow('重新检查')
    await expect(
      newOrder(user, browser, {
        quoteId: q.id,
        channel: 'balance',
        requestKey: id(),
        session: JSON.stringify({ ...JSON.parse(session), user: { email: 'other@example.com' } }),
      }),
    ).rejects.toThrow('对应的充值账号')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('recovers, submits once, polls the known id and completes only on completed', async () => {
    const { order, q } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok(remote(order.id), 202))
      .mockResolvedValueOnce(ok(remote(order.id, 'completed', 2)))
    vi.stubGlobal('fetch', fetcher)
    expect(await fulfillOrder(order.id)).toBe(false)
    expect((await internal(order.id)).status).toBe('processing')
    expect(
      (await testQuery(Prisma.sql`SELECT preflight_token FROM quotes WHERE id=${q.id}`)).rows[0]
        .preflight_token,
    ).toBeNull()
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('completed')
    expect(fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1)
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe(`${order.id}-v0`)
  })
  it('preserves the submission body and key after a timeout, even when the token later expires', async () => {
    const { order, q } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok(remote(order.id), 202))
    vi.stubGlobal('fetch', fetcher)
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({ uncertain: true })
    expect((await internal(order.id)).submissionAttempted).toBe(true)
    await testQuery(
      Prisma.sql`UPDATE quotes SET preflight_expires_at=now()-interval '1 minute' WHERE id=${q.id}`,
    )
    expect(await fulfillOrder(order.id)).toBe(false)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[3][1].body)
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe(
      fetcher.mock.calls[3][1].headers['Idempotency-Key'],
    )
  })
  it('asks for a fresh Session on a definitively rejected preflight, with no second redemption', async () => {
    const { order } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'OPERATION_NOT_READY', uncertain: false },
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', fetcher)
    expect(await fulfillOrder(order.id)).toBe(true)
    expect(await internal(order.id)).toMatchObject({
      status: 'needs_session',
      submissionAttempted: false,
      fulfillmentAttempt: 0,
    })
    const resume = stub()
    await confirmSession(user, order.id, session, browser)
    expect(await internal(order.id)).toMatchObject({ status: 'processing', fulfillmentAttempt: 1 })
    expect(resume.mock.calls.some(([url]) => url.endsWith('/redemptions'))).toBe(false)
  })
  it('refreshes an existing order with PUT and never selects a replacement card', async () => {
    const { order } = await purchase()
    await testQuery(
      Prisma.sql`UPDATE orders SET status='needs_session',redemption_id=${`ord_${order.id}`},redemption_version=1 WHERE id=${order.id}`,
    )
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(remote(order.id, 'needs_session', 2)))
      .mockResolvedValueOnce(ok(remote(order.id, 'queued', 3)))
    vi.stubGlobal('fetch', fetcher)
    await confirmSession(user, order.id, session, browser)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toMatch(/\/account-session$/)
    expect(fetcher.mock.calls[1][1].method).toBe('PUT')
    expect((await internal(order.id)).fulfillmentAttempt).toBe(0)
    expect((await internal(order.id)).redemptionVersion).toBe(3)
  })
  it('does not submit an unattempted expired ticket or refresh an uncertain submission', async () => {
    const { order, q } = await purchase()
    await testQuery(
      Prisma.sql`UPDATE quotes SET preflight_expires_at=now()-interval '1 minute' WHERE id=${q.id}`,
    )
    const fetcher = stub()
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('needs_session')
    expect(fetcher.mock.calls.every(([url]) => url.includes('/redemptions?'))).toBe(true)
    await testQuery(Prisma.sql`UPDATE orders SET submission_attempted=true WHERE id=${order.id}`)
    fetcher.mockClear()
    await expect(confirmSession(user, order.id, session, browser)).rejects.toThrow('仍待核对')
    expect(fetcher.mock.calls.every(([url]) => url.includes('/redemptions?'))).toBe(true)
  })
  it('rejects a foreign or stale recovery response without completing or replacing the local order', async () => {
    const { order } = await purchase()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok([{ ...remote(order.id), account_email: 'other@example.com' }])),
    )
    await expect(fulfillOrder(order.id)).rejects.toThrow('不匹配')
    expect((await internal(order.id)).redemptionId).toBeNull()
    await testQuery(
      Prisma.sql`UPDATE orders SET redemption_id=${`ord_${order.id}`},redemption_version=4 WHERE id=${order.id}`,
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(remote(order.id, 'completed', 3))))
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    })
    expect((await internal(order.id)).status).toBe('processing')
  })
  it('migrates legacy credentials atomically, binds each ciphertext to its row, and keeps imports idempotent', async () => {
    const itemId = id('legacy_'),
      code = 'synthetic-legacy-card',
      quoteId = id('q_')
    await testQuery(
      Prisma.sql`INSERT INTO inventory(id,product_id,code,fingerprint) VALUES(${itemId},${'upgrade'},${encrypt(code, 'getgpt')},${hash(code)})`,
    )
    await testQuery(
      Prisma.sql`INSERT INTO quotes(id,browser_digest,product_id,email,amount,preflight_token,expires_at,flow_version) VALUES(${quoteId},${browser},'upgrade',${email},8800,${encrypt('legacy-ticket', 'getgpt')},now()+interval '9 minutes',1)`,
    )
    await expect(importInventory('upgrade', [code], user.email)).rejects.toThrow('迁移')
    await transaction(migrateCredentialStorage)
    const row = (
      await testQuery(Prisma.sql`SELECT code,fingerprint FROM inventory WHERE id=${itemId}`)
    ).rows[0]
    expect(row.fingerprint).toBe(inventoryFingerprint(code))
    expect(openCredential(row.code, 'inventory', itemId)).toBe(code)
    expect(() => openCredential(row.code, 'preflight', itemId)).toThrow()
    expect(() => openCredential(row.code, 'inventory', 'another-row')).toThrow()
    const token = (
      await testQuery(Prisma.sql`SELECT preflight_token FROM quotes WHERE id=${quoteId}`)
    ).rows[0].preflight_token
    expect(openCredential(token, 'preflight', quoteId)).toBe('legacy-ticket')
    await transaction(migrateCredentialStorage)
    await importInventory('upgrade', [code, code], user.email)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int AS n FROM inventory WHERE fingerprint=${inventoryFingerprint(code)}`,
        )
      ).rows[0].n,
    ).toBe(1)
    expect(sealCredential(code, 'inventory', itemId)).not.toBe(row.code)
  })
})
