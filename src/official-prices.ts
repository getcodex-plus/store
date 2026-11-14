import type { Product } from './types'

// Official US monthly list prices, before tax. Checked on 2026-11-14:
// https://learn.chatgpt.com/docs/pricing
const officialMonthlyUsdCents: Record<string, number> = {
  go: 800,
  plus: 2000,
  pro5: 10000,
  pro20: 20000,
  promax: 50000,
}

export interface OfficialPriceComparison {
  usdCents: number
  cnyCents: number
  differenceCents: number
  discountPercent: number
}

export function officialPriceComparison(
  product: Pick<Product, 'plan' | 'upgrade' | 'price' | 'priceCurrency' | 'priceStatus'>,
  rate: { rateE8: number; expiresAt: string } | undefined,
  now = Date.now(),
): OfficialPriceComparison | undefined {
  const usdCents = officialMonthlyUsdCents[product.plan]
  if (
    !Number.isSafeInteger(usdCents) ||
    usdCents <= 0 ||
    product.upgrade ||
    product.priceStatus === 'pending' ||
    product.priceCurrency !== 'CNY' ||
    !Number.isSafeInteger(product.price) ||
    product.price <= 0 ||
    !rate ||
    !Number.isSafeInteger(rate.rateE8) ||
    rate.rateE8 <= 0 ||
    rate.rateE8 > 10000000000 ||
    !(Date.parse(rate.expiresAt) > now)
  )
    return undefined

  // Round the reference to the nearest fen without floating point drift.
  const cnyCents = Number((BigInt(usdCents) * BigInt(rate.rateE8) + 50000000n) / 100000000n)
  const differenceCents = cnyCents - product.price
  if (differenceCents <= 0) return undefined
  return {
    usdCents,
    cnyCents,
    differenceCents,
    // Round down so the displayed percentage never overstates the difference.
    discountPercent: Math.floor((differenceCents * 1000) / cnyCents) / 10,
  }
}
