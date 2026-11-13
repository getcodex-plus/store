import { expect, it } from 'vitest'
import { paymentLimitError, costBasedPrice } from './pricing'
import type { Settings } from './types'

it('calculates upgrade retail prices with integer rounding and rejects absent/invalid costs', () => {
  const rules = {
    fxRateBps: 71001,
    markupBps: 1500,
    serviceFee: 500,
    minimum: 100,
    roundingStep: 1 as const,
  }
  expect(costBasedPrice(1234, rules)).toBe(10576)
  expect(costBasedPrice(0, rules)).toBe(500)
  expect(() => costBasedPrice(NaN, rules)).toThrow()
  expect(() => costBasedPrice(-1, rules)).toThrow()
  expect(() => costBasedPrice(100, { ...rules, fxRateBps: 0 })).toThrow()
  expect(
    costBasedPrice(1000, {
      fxRateBps: 70000,
      markupBps: 0,
      serviceFee: 0,
      minimum: 100,
      minimumProfit: 2000,
      roundingStep: 1,
    }),
  ).toBe(9000)
  expect(
    costBasedPrice(1001, {
      fxRateBps: 71001,
      markupBps: 0,
      serviceFee: 0,
      minimum: 100,
      minimumProfit: 2000,
      roundingStep: 1,
    }),
  ).toBe(9108)
})
it('applies inclusive limits to the external portion, skipping full wallet payments', () => {
  const settings = { paymentLimits: { alipay: { min: 100, max: 5000 } } } as Settings
  expect(paymentLimitError(settings, 'alipay', 100)).toBe('')
  expect(paymentLimitError(settings, 'alipay', 5000)).toBe('')
  expect(paymentLimitError(settings, 'alipay', 99)).toContain('单笔支付范围')
  expect(paymentLimitError(settings, 'alipay', 5001)).toContain('单笔支付范围')
  expect(paymentLimitError(settings, 'alipay', 0)).toBe('')
  expect(paymentLimitError(settings, 'balance', 10000)).toBe('')
})
it('defaults fiat payments to a ¥2,000 ceiling without reducing the crypto limit', () => {
  const settings = {} as Settings
  for (const channel of ['alipay', 'wechat'] as const) {
    expect(paymentLimitError(settings, channel, 1)).toBe('')
    expect(paymentLimitError(settings, channel, 200000)).toBe('')
    expect(paymentLimitError(settings, channel, 200001)).toContain('单笔支付范围')
    expect(paymentLimitError(settings, channel, 0)).toBe('')
  }
  expect(paymentLimitError(settings, 'balance', 332900)).toBe('')
  expect(paymentLimitError(settings, 'crypto', 332900)).toBe('')
})
it('rounds upward after applying profit floors, preserving exact step boundaries', () => {
  const rules = { fxRateBps: 10000, markupBps: 0, serviceFee: 0, minimum: 1 }
  expect(costBasedPrice(12901, rules)).toBe(13000)
  expect(costBasedPrice(12901, { ...rules, roundingStep: 1 })).toBe(12901)
  expect(costBasedPrice(12901, { ...rules, roundingStep: 10 })).toBe(12910)
  expect(costBasedPrice(12901, { ...rules, roundingStep: 100 })).toBe(13000)
  expect(costBasedPrice(12901, { ...rules, roundingStep: 1000 })).toBe(13000)
  expect(costBasedPrice(13000, { ...rules, roundingStep: 1000 })).toBe(13000)
  expect(costBasedPrice(12901, { ...rules, minimumProfit: 1000, roundingStep: 1000 })).toBe(14000)
  expect(() =>
    costBasedPrice(100000000, { ...rules, minimumProfit: 1, roundingStep: 1000 }),
  ).toThrow('超出')
  expect(() => costBasedPrice(100, { ...rules, roundingStep: 3 as 1 })).toThrow('规则无效')
})
