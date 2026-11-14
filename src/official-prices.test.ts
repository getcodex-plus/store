import { describe, expect, it } from 'vitest'
import { officialPriceComparison } from './official-prices'

const now = Date.parse('2026-11-14T08:00:00Z')
const rate = { rateE8: 666845520, expiresAt: '2026-11-15T08:00:00Z' }
const product = {
  plan: 'plus',
  upgrade: false,
  price: 12900,
  priceCurrency: 'CNY' as const,
}

describe('official monthly price comparison', () => {
  it('converts USD to CNY in fen and only advertises the actual positive difference', () => {
    expect(officialPriceComparison(product, rate, now)).toEqual({
      usdCents: 2000,
      cnyCents: 13337,
      differenceCents: 437,
      discountPercent: 3.2,
    })
    expect(officialPriceComparison({ ...product, price: 13337 }, rate, now)).toBeUndefined()
    expect(officialPriceComparison({ ...product, price: 14000 }, rate, now)).toBeUndefined()
  })

  it('hides comparisons for missing, expired and invalid rates', () => {
    for (const invalid of [
      undefined,
      { ...rate, expiresAt: new Date(now).toISOString() },
      { ...rate, expiresAt: 'invalid' },
      { ...rate, rateE8: NaN },
      { ...rate, rateE8: 0 },
      { ...rate, rateE8: -1 },
      { ...rate, rateE8: 0.5 },
      { ...rate, rateE8: 10000000001 },
    ])
      expect(officialPriceComparison(product, invalid, now)).toBeUndefined()
  })

  it('does not compare upgrade quotes, pending prices, unsupported plans or unconverted prices', () => {
    for (const invalid of [
      { ...product, upgrade: true },
      { ...product, priceStatus: 'pending' as const },
      { ...product, plan: 'custom' },
      { ...product, priceCurrency: 'USD' as const },
      { ...product, price: 0 },
      { ...product, price: NaN },
    ])
      expect(officialPriceComparison(invalid, rate, now)).toBeUndefined()
  })

  it.each([
    ['go', 800],
    ['plus', 2000],
    ['pro5', 10000],
    ['pro20', 20000],
    ['promax', 50000],
  ])('uses the corresponding official monthly price for %s', (plan, usdCents) => {
    expect(officialPriceComparison({ ...product, plan, price: 100 }, rate, now)?.usdCents).toBe(
      usdCents,
    )
  })
})
