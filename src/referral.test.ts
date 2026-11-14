import { describe, expect, it } from 'vitest'
import { defaultReferralTiers, referralFunds, referralProgress } from './referral'
import {
  referralTiersSchema,
  withdrawalSchema,
  withdrawalReviewSchema,
} from './server/referral-policy'

describe('invitation levels and withdrawal policy', () => {
  it.each([
    [0, 200, 5],
    [4, 200, 1],
    [5, 300, 15],
    [19, 300, 1],
    [20, 400, 30],
    [49, 400, 1],
    [50, 500, 0],
    [500, 500, 0],
  ])('uses the correct tier at %i qualified referrals', (count, rate, remaining) => {
    const result = referralProgress(count, {})
    expect(result.current.rateBps).toBe(rate)
    expect(result.remaining).toBe(remaining)
    expect(result.progress).toBeGreaterThanOrEqual(0)
    expect(result.progress).toBeLessThanOrEqual(100)
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
