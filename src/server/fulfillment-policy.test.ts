import { describe, expect, it } from 'vitest'
import { moneyDecimals, validateFulfillment } from './fulfillment-policy'
import { costBasedPrice } from '../pricing'

const rules = {
  fxRateBps: 70000,
  markupBps: 2500,
  serviceFee: 0,
  minimum: 100,
  minimumProfit: 1000,
  roundingStep: 100 as const,
}
const original = {
  email: 'buyer@example.com',
  amount: 8800,
  targetPlan: 'pro20',
  pricingSnapshot: {
    mode: 'markup' as const,
    rules,
    rateE8: 700000000,
    providerQuote: { amount_minor: 1000, currency: 'USD', currency_decimals: 2 },
  },
}
const ready = {
  status: 'ready' as const,
  preflight_token: 'private-token',
  account_email: original.email,
  quote: {
    amount_minor: 1000,
    currency: 'USD',
    currency_decimals: 2,
    business: 'upgrade',
    target_plan: 'pro_200',
  },
}
describe('new AICDK monetary and fulfillment contract', () => {
  it('pins a discounted Plus order to its business, country and authorized cost', () => {
    const quote = {
      email: original.email,
      targetPlan: 'plus',
      amount: 12900,
      pricingSnapshot: {
        mode: 'fixed' as const,
        fulfillment: {
          business: 'plus_50_percent_discount' as const,
          country: 'jp',
          quote: { currency: 'JPY', amount_minor: 1300, currency_decimals: 0 },
        },
      },
    }
    const result = {
      ...ready,
      quote: {
        ...quote.pricingSnapshot.fulfillment.quote,
        target_plan: 'plus',
        business: 'plus_50_percent_discount',
        billing_country: 'JP',
      },
    }
    expect(() => validateFulfillment(result, quote)).not.toThrow()
    for (const change of [
      { business: 'recharge' },
      { billing_country: 'us' },
      { amount_minor: 1400 },
      { currency: 'USD' },
      { target_plan: 'pro_100' },
    ]) {
      expect(() =>
        validateFulfillment({ ...result, quote: { ...result.quote, ...change } }, quote),
      ).toThrow()
    }
    expect(() =>
      validateFulfillment(
        {
          ...result,
          quote: { ...result.quote, billing_country: undefined },
        },
        quote,
      ),
    ).not.toThrow()
    expect(() => validateFulfillment(result, { ...quote, targetPlan: 'pro20' })).toThrow()
    expect(() =>
      validateFulfillment(result, {
        ...quote,
        pricingSnapshot: { mode: 'fixed' },
      }),
    ).toThrow('业务')
  })
  it('uses currency precision, including JPY zero digits and KWD three digits', () => {
    expect(moneyDecimals({ currency: 'JPY', amount_minor: 1000 })).toBe(0)
    expect(moneyDecimals({ currency: 'KWD', amount_minor: 1000 })).toBe(3)
    expect(costBasedPrice(1000, rules, 5000000, 0)).toBe(6300)
    expect(costBasedPrice(1000, rules, 2300000000, 3)).toBe(3300)
    expect(() =>
      moneyDecimals({ currency: 'USD', amount_minor: 1000, currency_decimals: 0 }),
    ).toThrow('精度')
    expect(() => moneyDecimals({ currency: 'ZZZ', amount_minor: 1000 })).toThrow('币种')
  })
  it('binds the actual redemption to the quoted account, business, plan and price', () => {
    expect(() => validateFulfillment(ready, original)).not.toThrow()
    expect(() =>
      validateFulfillment({ ...ready, account_email: 'other@example.com' }, original),
    ).toThrow('不匹配')
    expect(() =>
      validateFulfillment(
        { ...ready, quote: { ...ready.quote, target_plan: 'pro_100' } },
        original,
      ),
    ).toThrow('不匹配')
    expect(() =>
      validateFulfillment({ ...ready, quote: { ...ready.quote, business: 'recharge' } }, original),
    ).toThrow('业务')
    expect(() =>
      validateFulfillment({ ...ready, quote: { ...ready.quote, currency: 'EUR' } }, original),
    ).toThrow('币种')
    expect(() =>
      validateFulfillment({ ...ready, quote: { ...ready.quote, amount_minor: 2000 } }, original),
    ).toThrow('成本')
  })
  it('requires an exact client request identity on recovered redemptions', () => {
    const result = {
      ...ready,
      status: 'completed' as const,
      id: 'ord_test',
      version: 1,
      client_request_id: 'o_testorder',
    }
    expect(() => validateFulfillment(result, original, 'o_testorder')).not.toThrow()
    expect(() => validateFulfillment(result, original, 'o_other')).toThrow('不匹配')
  })
})
