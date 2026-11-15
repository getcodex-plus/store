import { describe, expect, it } from 'vitest'
import { defaultReferralTiers, referralFunds, referralProgress } from './referral'
import {
  referralTiersSchema,
  withdrawalSchema,
  withdrawalReviewSchema,
} from './server/referral-policy'

describe('invitation levels and withdrawal policy', () => {
  it.each([1, 2, 6])('supports %i configured tiers at every promotion boundary', (count) => {
    const tiers = referralTiersSchema.parse(
      Array.from({ length: count }, (_, index) => ({
        id: `custom_${index}`,
        name: `自定义等级 ${index + 1}`,
        minimumInvites: index * 3,
        rateBps: 125 + index * 100,
      })),
    )
    for (const [index, tier] of tiers.entries()) {
      expect(referralProgress(tier.minimumInvites, { referralTiers: tiers })).toMatchObject({
        current: tier,
        next: tiers[index + 1] ?? null,
        remaining: index < count - 1 ? 3 : 0,
        progress: index < count - 1 ? 0 : 100,
      })
      if (index > 0)
        expect(referralProgress(tier.minimumInvites - 1, { referralTiers: tiers }).current).toEqual(
          tiers[index - 1],
        )
    }
    expect(referralProgress(1000000, { referralTiers: tiers }).current).toEqual(tiers.at(-1))
  })

  it('preserves assignments by ID after edits and falls back when the assigned tier is deleted', () => {
    const tiers = [
      { id: 'base', name: '普通会员', minimumInvites: 0, rateBps: 150 },
      { id: 'custom', name: '推广伙伴', minimumInvites: 10, rateBps: 650 },
    ]
    expect(referralProgress(0, { referralTiers: tiers }, 'custom')).toMatchObject({
      manual: true,
      current: tiers[1],
      next: null,
    })
    expect(referralProgress(20, { referralTiers: tiers.slice(0, 1) }, 'custom')).toMatchObject({
      manual: false,
      current: tiers[0],
      next: null,
      remaining: 0,
      progress: 100,
    })
  })

  it.each([
    [0, 300, 5],
    [4, 300, 1],
    [5, 400, 15],
    [19, 400, 1],
    [20, 500, 30],
    [49, 500, 1],
    [50, 600, 0],
    [500, 600, 0],
  ])('uses the correct tier at %i qualified referrals', (count, rate, remaining) => {
    const result = referralProgress(count, {})
    expect(result.current.rateBps).toBe(rate)
    expect(result.remaining).toBe(remaining)
    expect(result.progress).toBeGreaterThanOrEqual(0)
    expect(result.progress).toBeLessThanOrEqual(100)
  })

  it('uses the assigned tier regardless of invite count and supports returning to automatic levels', () => {
    expect(referralProgress(0, {}, 'partner')).toMatchObject({
      manual: true,
      current: { id: 'partner', rateBps: 600 },
      next: null,
    })
    expect(referralProgress(100, {}, 'sharer')).toMatchObject({
      manual: true,
      current: { id: 'sharer', rateBps: 400 },
      next: null,
    })
    for (const tierId of [null, 'deleted-tier'])
      expect(referralProgress(8, {}, tierId)).toMatchObject({
        manual: false,
        current: { id: 'sharer' },
        next: { id: 'ambassador' },
        remaining: 12,
      })
    expect(
      referralProgress(
        0,
        {
          referralTiers: defaultReferralTiers.map((tier) => ({ ...tier, rateBps: 600 })),
        },
        'partner',
      ).current.rateBps,
    ).toBe(600)
  })

  it('keeps unsettled, reversed and rejected amounts out of the withdrawable limit', () => {
    expect(
      referralFunds(
        [
          { amount: 50000, status: 'available' },
          { amount: 10000, status: 'pending' },
          { amount: 40000, status: 'reversed' },
        ],
        [
          { amount: 10000, status: 'paid' },
          { amount: 3000, status: 'pending' },
          { amount: 2000, status: 'processing' },
          { amount: 8000, status: 'rejected' },
        ],
      ),
    ).toEqual({
      settled: 50000,
      pending: 10000,
      frozen: 5000,
      withdrawn: 10000,
      available: 35000,
      shortfall: 0,
    })
    expect(
      referralFunds(
        [{ amount: 1000, status: 'available' }],
        [
          { amount: 1800, status: 'paid' },
          { amount: 200, status: 'pending' },
        ],
      ),
    ).toMatchObject({ available: 0, shortfall: 1000 })
  })

  it('rejects invalid thresholds, decreasing rates and rates above the agreed 9% cap', () => {
    expect(referralTiersSchema.safeParse(defaultReferralTiers).success).toBe(true)
    for (const invalid of [
      [],
      [{ ...defaultReferralTiers[0], minimumInvites: 1 }],
      [{ ...defaultReferralTiers[0], name: '   ' }],
      [{ ...defaultReferralTiers[0], rateBps: 12.5 }],
      defaultReferralTiers.map((tier) => ({ ...tier, id: 'duplicate' })),
      defaultReferralTiers.map((tier) => ({ ...tier, minimumInvites: 0 })),
      defaultReferralTiers.map((tier, i) => ({ ...tier, rateBps: i === 3 ? 1000 : tier.rateBps })),
      defaultReferralTiers.map((tier, i) => ({ ...tier, rateBps: i === 2 ? 100 : tier.rateBps })),
    ])
      expect(referralTiersSchema.safeParse(invalid).success).toBe(false)
  })

  it('requires confirmed, named recipients and a matching USDT network/address', () => {
    const input = {
      amount: 5000,
      method: '支付宝',
      account: 'pay@example.com',
      recipientName: '张小明',
      confirmed: true,
      requestKey: 'a'.repeat(32),
    }
    expect(withdrawalSchema.parse(input).network).toBeNull()
    for (const invalid of [
      { ...input, amount: -1 },
      { ...input, amount: 100.1 },
      { ...input, recipientName: '   ' },
      { ...input, confirmed: false },
      { ...input, method: 'USDT' },
      { ...input, method: 'USDT', network: 'ERC20', account: `T${'a'.repeat(33)}` },
      { ...input, method: 'USDT', network: 'TRC20', account: `0x${'a'.repeat(40)}` },
      { ...input, method: 'USDT', network: 'BSC', account: `T${'a'.repeat(33)}` },
      { ...input, method: 'USDT', network: 'Polygon', account: `0x${'g'.repeat(40)}` },
      { ...input, method: 'USDT', network: 'unknown', account: `0x${'a'.repeat(40)}` },
    ])
      expect(withdrawalSchema.safeParse(invalid).success).toBe(false)
    for (const network of ['ERC20', 'BSC', 'Polygon'])
      expect(
        withdrawalSchema.safeParse({
          ...input,
          method: 'USDT',
          network,
          account: `0x${'a'.repeat(40)}`,
        }).success,
      ).toBe(true)
  })

  it('requires a reason for rejection and an actual transaction reference for payout', () => {
    expect(withdrawalReviewSchema.safeParse({ id: 'w1', status: 'paid' }).success).toBe(false)
    expect(withdrawalReviewSchema.safeParse({ id: 'w1', status: 'rejected' }).success).toBe(false)
    expect(withdrawalReviewSchema.safeParse({ id: 'w1', status: 'processing' }).success).toBe(true)
  })
})
