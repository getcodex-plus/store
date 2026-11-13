import { expect, it } from 'vitest'
import { parseExchangeRate } from './exchange-rates'
import { convertedSubscriptionPrice, costBasedPrice } from '../pricing'

it('validates the source date and bounds cache lifetime without extending old daily rates', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  const rate = parseExchangeRate({ date: '2026-11-12', usd: { cny: 6.6684552 } }, now)
  expect(rate.rateE8).toBe(666845520)
  expect(rate.expiresAt).toBe('2026-11-15T00:00:00.000Z')
  expect(
    parseExchangeRate({ date: '2026-11-12', usd: { cny: 6.6684552 } }, now + 3600000).expiresAt,
  ).toBe(rate.expiresAt)
  for (const input of [
    { date: '2026-11-10', usd: { cny: 7 } },
    { date: '2026-11-14', usd: { cny: 7 } },
    { date: '2026-02-30', usd: { cny: 7 } },
    { date: '2026-11-13', usd: { cny: 0 } },
    { date: '2026-11-13', usd: { cny: -7 } },
    { date: '2026-11-13', usd: { cny: '7' } },
    { date: '2026-11-13', usd: { cny: 101 } },
    { date: '2026-11-13', usd: {} },
    null,
  ])
    expect(() => parseExchangeRate(input, now)).toThrow('INVALID_EXCHANGE_RATE')
})

it('converts fixed USD retail prices precisely before rounding and applies automatic FX to upgrades', () => {
  expect(convertedSubscriptionPrice(2000, 666845520, 1)).toBe(13337)
  expect(convertedSubscriptionPrice(2000, 666845520)).toBe(13400)
  expect(convertedSubscriptionPrice(2000, 666845520, 100)).toBe(13400)
  expect(convertedSubscriptionPrice(2000, 700000000, 100)).toBe(14000)
  expect(convertedSubscriptionPrice(1, 666845520, 1)).toBe(7)
  expect(() => convertedSubscriptionPrice(100, NaN)).toThrow()
  expect(() => convertedSubscriptionPrice(100000000, 700000000)).toThrow('超出')
  expect(
    costBasedPrice(
      1000,
      {
        fxRateBps: 70000,
        markupBps: 1000,
        serviceFee: 500,
        minimum: 100,
      },
      666845520,
    ),
  ).toBe(7900)
})
