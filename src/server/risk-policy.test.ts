import { describe, expect, it } from 'vitest'
import { decideRisk, riskLimits, riskScenes, riskVersion } from './risk-policy'

describe('ZEN risk policy', () => {
  it('enforces the configured budgets and windows for each business dimension', async () => {
    const expected = [
      ['events', 'browser', 'events', 120, 60],
      ['quote', 'browser', 'quote', 12, 60],
      ['quote', 'global', 'aicdk:account-check', 12, 60],
      ['quote', 'ip', 'quote', 60, 60],
      ['quote', 'user', 'quote', 60, 60],
      ['quote-target', 'target', 'quote-target', 12, 60],
      ['order', 'browser', 'order', 24, 600],
      ['order', 'ip', 'order', 40, 600],
      ['order', 'user', 'order', 40, 600],
      ['order-contact', 'email', 'guest-contact', 10, 600],
      ['preflight', 'global', 'aicdk:preflight', 12, 60],
      ['session-update', 'browser', 'session-update', 12, 60],
      ['session-update', 'ip', 'session-update', 40, 60],
      ['session-update', 'user', 'session-update', 40, 60],
      ['email', 'email', 'email', 3, 600],
      ['email', 'global', 'email-global', 1000, 600],
      ['fx-refresh', 'user', 'fx-refresh', 12, 60],
      ['inventory-import', 'user', 'inventory-import', 20, 60],
      ['withdrawal-estimate', 'user', 'withdrawal-estimate', 60, 60],
      ['withdrawal-fx-refresh', 'user', 'withdrawal-fx-refresh', 12, 60],
      ['withdrawal-request', 'user', 'withdrawal-request', 10, 600],
      ['withdrawal-request', 'ip', 'withdrawal-request', 10, 600],
      ['coupon-preview', 'browser', 'coupon-preview', 30, 60],
      ['coupon-preview', 'ip', 'coupon-preview', 60, 60],
    ]
    const actual = []
    for (const scene of riskScenes.filter((scene) => !scene.startsWith('auth-'))) {
      for (const rule of await riskLimits(scene, false)) {
        expect(rule.mode).toBe('enforce')
        actual.push([scene, rule.dimension, rule.prefix, rule.limit, rule.seconds])
      }
    }
    expect(actual.sort()).toEqual(expected.sort())
  })

  it('retains auth SDK budgets and demo exceptions without relaxing production', async () => {
    for (const [scene, live, demo] of [
      ['auth-default', 60, 300],
      ['auth-opaque', 10, 100],
      ['auth-otp', 3, 100],
    ] as const) {
      expect((await riskLimits(scene, false))[0]).toMatchObject({ limit: live, seconds: 60 })
      expect((await riskLimits(scene, true))[0]).toMatchObject({ limit: demo, seconds: 60 })
    }
    expect((await riskLimits('email', true)).map((r) => r.limit)).toEqual([100, 10000])
    expect((await riskLimits('quote', true)).some((r) => r.dimension === 'global')).toBe(false)
  })

  it('allows the exact budget and flags the next request through the native engine', async () => {
    for (const scene of riskScenes) {
      for (const rule of await riskLimits(scene, false)) {
        expect(rule.mode).toBe('enforce')
        expect(await decideRisk({ kind: 'rate', count: rule.limit, ...rule })).toMatchObject({
          action: 'allow',
        })
        expect(await decideRisk({ kind: 'rate', count: rule.limit + 1, ...rule })).toEqual({
          action: 'deny',
          mode: rule.mode,
          reason: rule.reason,
        })
      }
    }
  })

  it('checks self-referral and first-order eligibility with self-referral taking precedence', async () => {
    for (const self of [false, true]) {
      for (const firstOrderOnly of [false, true]) {
        for (const previous of [false, true]) {
          const result = await decideRisk({ kind: 'referral', self, firstOrderOnly, previous })
          expect(result.action).toBe(self || (firstOrderOnly && previous) ? 'deny' : 'allow')
          if (self) expect(result.reason).toBe('SELF_REFERRAL')
        }
      }
    }
  })

  it('requires verification only when enabled and not yet verified', async () => {
    for (const required of [false, true]) {
      for (const verified of [false, true]) {
        expect(await decideRisk({ kind: 'challenge', required, verified })).toMatchObject({
          action: required && !verified ? 'challenge' : 'allow',
        })
      }
    }
  })

  it('enforces all business rules and rejects malformed facts', async () => {
    expect(await decideRisk({ kind: 'order', unpaidOrders: 5 })).toEqual({
      action: 'review',
      mode: 'enforce',
      reason: 'UNPAID_ORDER_ACCUMULATION',
    })
    expect(
      await decideRisk({ kind: 'withdrawal', sharedPayoutUsers: 3, accountAgeHours: 100 }),
    ).toEqual({ action: 'review', mode: 'enforce', reason: 'SHARED_PAYOUT_ACCOUNT' })
    expect(
      await decideRisk({ kind: 'withdrawal', sharedPayoutUsers: 1, accountAgeHours: 23 }),
    ).toMatchObject({ mode: 'enforce', reason: 'NEW_ACCOUNT_WITHDRAWAL' })
    await expect(decideRisk({ kind: 'order', unpaidOrders: NaN })).rejects.toMatchObject({
      status: 503,
    })
    await expect(decideRisk({ kind: 'referral' } as never)).rejects.toMatchObject({ status: 503 })
    await expect(riskLimits('unknown' as never, false)).rejects.toMatchObject({ status: 503 })
    expect(riskVersion).toMatch(/^zen-v1-[a-f0-9]{16}$/)
  })
})
