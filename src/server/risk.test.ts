import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_risk_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
})
import { db, transaction } from './db'
import { id, hash, encrypt } from './crypto'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import {
  checkRiskRate,
  checkRiskChallenge,
  trustedRiskIP,
  payoutFingerprint,
  riskDigest,
  assessRisk,
} from './risk'
import { backfillRiskIdentities } from '../../scripts/backfill-risk'
import { saveIntegration } from './integrations/config'
import { adminData } from './services'
import { userView } from './data'
import { seedDatabase } from '../../scripts/seed'

describe('Risk identity boundaries', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('ignores forwarded headers without an explicitly trusted proxy', () => {
    vi.stubEnv('TRUST_PROXY', 'false')
    expect(trustedRiskIP(new Headers({ 'x-real-ip': '192.0.2.1' }))).toBeUndefined()
    vi.stubEnv('TRUST_PROXY', 'true')
    expect(trustedRiskIP(new Headers({ 'x-forwarded-for': '192.0.2.1' }))).toBeUndefined()
    expect(trustedRiskIP(new Headers({ 'x-real-ip': '192.0.2.1, 192.0.2.2' }))).toBeUndefined()
    expect(trustedRiskIP(new Headers({ 'x-real-ip': 'fe80::1%en0' }))).toBeUndefined()
    expect(trustedRiskIP(new Headers({ 'x-real-ip': '::ffff:192.0.2.1' }))).toBe('192.0.2.1')
    expect(trustedRiskIP(new Headers({ 'x-real-ip': '2001:0db8:0:0:0:0:0:1' }))).toBe('2001:db8::1')
  })
  it('separates HMAC domains and preserves case-sensitive payout identities', () => {
    expect(riskDigest('email', 'example')).not.toBe(riskDigest('user', 'example'))
    expect(payoutFingerprint('USDT', 'ERC20', '0xAbCd')).toBe(
      payoutFingerprint('USDT', 'ERC20', '0xabcd'),
    )
    expect(payoutFingerprint('USDT', 'TRC20', 'TAbCd')).not.toBe(
      payoutFingerprint('USDT', 'TRC20', 'Tabcd'),
    )
    expect(payoutFingerprint('USDT', 'ERC20', '0xabcd')).not.toBe(
      payoutFingerprint('USDT', 'BSC', '0xabcd'),
    )
    expect(payoutFingerprint('支付宝', null, 'same')).not.toBe(
      payoutFingerprint('微信', null, 'same'),
    )
  })
})

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('Risk persistence and concurrency', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await transaction(seedDatabase)
  }, 30000)
  afterAll(cleanupTestDatabase)
  afterEach(() => vi.unstubAllGlobals())

  it('keeps existing buckets, rejects concurrent excess requests and persists denial evidence', async () => {
    const user = id()
    await db.rateLimit.create({
      data: { key: `fx-refresh:${user}`, count: 11, expiresAt: new Date(Date.now() + 60000) },
    })
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => checkRiskRate('fx-refresh', { user })),
    )
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      outcomes.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 429),
    ).toBe(true)
    expect(
      (await db.rateLimit.findUniqueOrThrow({ where: { key: `fx-refresh:${user}` } })).count,
    ).toBe(21)
    expect(
      await db.riskEvent.count({ where: { scene: 'fx-refresh', effectiveAction: 'deny' } }),
    ).toBe(9)
    await db.rateLimit.update({
      where: { key: `fx-refresh:${user}` },
      data: { expiresAt: new Date(0) },
    })
    await expect(checkRiskRate('fx-refresh', { user })).resolves.toBeUndefined()
    expect(
      (await db.rateLimit.findUniqueOrThrow({ where: { key: `fx-refresh:${user}` } })).count,
    ).toBe(1)
  })

  it('does not reset email limits when the browser changes', async () => {
    const email = `${id()}@example.com`
    for (let i = 0; i < 10; i++) await checkRiskRate('order-contact', { email, browser: id() })
    await expect(checkRiskRate('order-contact', { email, browser: id() })).rejects.toMatchObject({
      status: 429,
    })
    expect(
      (await db.rateLimit.findUniqueOrThrow({ where: { key: `guest-contact:${hash(email)}` } }))
        .count,
    ).toBe(11)
  })

  it('blocks excess requests across rotated cookies through IP and user limits', async () => {
    const ip = '192.0.2.45'
    const user = id()
    const outcomes = await Promise.allSettled(
      Array.from({ length: 42 }, () => checkRiskRate('order', { browser: id(), ip, user })),
    )
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(40)
    expect(
      outcomes
        .filter((result) => result.status === 'rejected')
        .every((result) => result.reason.status === 429),
    ).toBe(true)
    const events = await db.riskEvent.findMany({ where: { scene: 'order' } })
    expect(events).toHaveLength(4)
    expect(events.every((e) => e.mode === 'enforce' && e.effectiveAction === 'deny')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(ip)
    expect(JSON.stringify(events)).not.toContain(user)
    expect(events.some((e) => (e.reasonCodes as string[]).includes('ORDER_IP_RATE'))).toBe(true)
  })

  it('requires mandatory legacy subjects and does not silently bypass them', async () => {
    await expect(checkRiskRate('order', {})).rejects.toMatchObject({ status: 503 })
    await expect(checkRiskRate('order', { browser: id() })).resolves.toBeUndefined()
    await expect(checkRiskRate('withdrawal-request', {})).rejects.toMatchObject({ status: 503 })
  })

  it('enforces the recharge target independently of cookies', async () => {
    const target = `${id()}@example.com`
    for (let i = 0; i < 12; i++) await checkRiskRate('quote-target', { target, browser: id() })
    await expect(checkRiskRate('quote-target', { target, browser: id() })).rejects.toMatchObject({
      status: 429,
    })
  })

  it('records challenge failures without recording the token and accepts only verified results', async () => {
    await saveIntegration(
      {
        provider: 'turnstile',
        enabled: true,
        public: { siteKey: 'test-site', login: 'true', purchase: 'true' },
        secrets: { secret: 'test-private-key' },
      },
      'test-admin',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }))),
    )
    await expect(checkRiskChallenge('purchase', 'private-challenge-value')).rejects.toMatchObject({
      status: 403,
    })
    const event = await db.riskEvent.findFirstOrThrow({ where: { scene: 'challenge:purchase' } })
    expect(event.action).toBe('challenge')
    expect(JSON.stringify(event)).not.toContain('private-challenge-value')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              action: 'purchase',
              hostname: 'localhost',
            }),
          ),
      ),
    )
    await expect(checkRiskChallenge('purchase', 'valid-token')).resolves.toBeUndefined()
  })

  it('rolls back business decisions with failed transactions, and commits successful evidence', async () => {
    const referenceId = id()
    await expect(
      transaction(async (client) => {
        await assessRisk(
          'order-assessment',
          { kind: 'order', unpaidOrders: 5 },
          {},
          referenceId,
          client,
        )
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.riskEvent.count({ where: { referenceId } })).toBe(0)
    await transaction((client) =>
      assessRisk('order-assessment', { kind: 'order', unpaidOrders: 5 }, {}, referenceId, client),
    )
    expect(await db.riskEvent.count({ where: { referenceId } })).toBe(1)
  })

  it('backfills historical encrypted payout identities idempotently without exposing the accounts', async () => {
    const users = await Promise.all(
      [1, 2].map(() =>
        db.user.create({
          data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
        }),
      ),
    )
    const account = 'historical@example.com'
    for (const user of users) {
      await db.withdrawal.create({
        data: {
          id: id('w_'),
          userId: user.id,
          amount: 100,
          method: '支付宝',
          account: encrypt(account, `withdrawal:${user.id}`),
          requestKey: id(),
        },
      })
    }
    expect(await backfillRiskIdentities()).toBe(2)
    expect(await backfillRiskIdentities()).toBe(0)
    const rows = await db.withdrawal.findMany()
    expect(new Set(rows.map((r) => r.payoutFingerprint))).toEqual(
      new Set([payoutFingerprint('支付宝', null, account)]),
    )
    expect(rows.every((r) => r.account !== account)).toBe(true)
  })

  it('only exposes risk history to administrators with audit read permission', async () => {
    const actor = userView(
      await db.user.create({
        data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
      }),
    )
    expect((await adminData({ ...actor, permissions: ['admin:access'] })).riskEvents).toEqual([])
    const result = await adminData({ ...actor, permissions: ['admin:access', 'audit:read'] })
    expect(result.riskEvents!.length).toBeGreaterThan(0)
    expect(result.riskEvents![0]).not.toHaveProperty('subjects')
  })
})
