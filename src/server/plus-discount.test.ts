import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./exchange-rates', () => ({
  exchangeRate: vi.fn(),
  supportedCurrency: (currency: string) => Intl.supportedValuesOf('currency').includes(currency),
}))
import { exchangeRate } from './exchange-rates'
import { rankDiscountCountries } from './plus-discount'

describe('Plus discount country costs', () => {
  beforeEach(() => vi.mocked(exchangeRate).mockReset())

  it('compares the available countries by amount, ignoring countries without cards', async () => {
    expect(
      await rankDiscountCountries(
        {
          tr: { amount_minor: 100, currency: 'USD' },
          us: { amount_minor: 1000, currency: 'USD' },
          jp: { amount_minor: 900, currency: 'USD' },
        },
        ['us', 'jp'],
      ),
    ).toEqual(['jp', 'us'])
    expect(exchangeRate).not.toHaveBeenCalled()
  })

  it('normalizes mixed currencies with their precision and uses exact costs', async () => {
    vi.mocked(exchangeRate).mockImplementation(async (_required, currency) => ({
      rateE8: currency === 'JPY' ? 5000000 : 700000000,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      fetchedAt: new Date().toISOString(),
      sourceDate: '2026-11-14',
    }))
    expect(
      await rankDiscountCountries(
        {
          us: { amount_minor: 1000, currency: 'USD', currency_decimals: 2 },
          jp: { amount_minor: 1300, currency: 'JPY', currency_decimals: 0 },
        },
        ['us', 'jp'],
      ),
    ).toEqual(['jp', 'us'])
    expect(
      await rankDiscountCountries(
        {
          us: { amount_minor: 1, currency: 'USD' },
          jp: { amount_minor: 1, currency: 'JPY' },
        },
        ['us', 'jp'],
      ),
    ).toEqual(['jp', 'us'])
  })

  it('does not guess the cheapest country when an exchange rate is missing', async () => {
    vi.mocked(exchangeRate).mockResolvedValue(undefined)
    expect(
      await rankDiscountCountries(
        {
          us: { amount_minor: 1000, currency: 'USD' },
          jp: { amount_minor: 1300, currency: 'JPY' },
        },
        ['us', 'jp'],
      ),
    ).toEqual([])
  })

  it('rejects invalid currency precision and breaks equal-cost ties consistently', async () => {
    expect(
      await rankDiscountCountries(
        {
          us: { amount_minor: 1000, currency: 'USD', currency_decimals: 0 },
        },
        ['us'],
      ),
    ).toEqual([])
    expect(
      await rankDiscountCountries(
        {
          us: { amount_minor: 1000, currency: 'USD' },
          jp: { amount_minor: 1000, currency: 'USD' },
        },
        ['us', 'jp'],
      ),
    ).toEqual(['jp', 'us'])
  })
})
