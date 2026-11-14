import { ApiError } from './config'
import { type DbClient } from './db'
import { discountInventoryCountries, reserveInventory } from './database-sql'
import { exchangeRate } from './exchange-rates'
import { moneyDecimals, validateFulfillment, type FulfillmentQuote } from './fulfillment-policy'
import { openCredential } from './credential-storage'
import {
  preflight,
  UpstreamError,
  type AicdkBinding,
  type ProviderMoney,
} from './integrations/aicdk'

// Compare exact normalized costs, without rounding each offer to whole yuan.
// Missing FX means we cannot establish the cheapest route: leave this optional
// optimization to a later quote, while the ordinary fixed-price route stays usable.
export async function rankDiscountCountries(
  quotes: Record<string, ProviderMoney>,
  countries: string[],
) {
  const candidates = countries.filter((country) => quotes[country])
  const currencies = new Set(candidates.map((country) => quotes[country].currency))
  const rates = new Map<string, number>()
  if (currencies.size > 1) {
    for (const currency of currencies) {
      let rate
      try {
        rate = await exchangeRate(false, currency)
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
      }
      if (rate) rates.set(currency, rate.rateE8)
    }
    if (rates.size !== currencies.size) return []
  }
  try {
    return candidates
      .map((country) => {
        const money = quotes[country]
        const decimals = moneyDecimals(money)
        return {
          country,
          // All supported precisions fit within six decimal places.
          cost:
            BigInt(money.amount_minor) *
            BigInt(rates.get(money.currency) ?? 1) *
            10n ** BigInt(6 - decimals),
        }
      })
      .sort((a, b) =>
        a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.country.localeCompare(b.country),
      )
      .map(({ country }) => country)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return []
  }
}

export async function reservePlusDiscount(
  client: DbClient,
  productId: string,
  quote: FulfillmentQuote,
  session: unknown,
  binding: AicdkBinding,
) {
  const offer = quote.pricingSnapshot?.plusDiscount
  if (!offer || quote.targetPlan !== 'plus' || quote.pricingSnapshot?.mode !== 'fixed') return null
  const countries = await rankDiscountCountries(
    offer.quotes,
    await discountInventoryCountries(client, productId),
  )
  for (const country of countries) {
    const stock = await reserveInventory(client, productId, country)
    // Another checkout may have locked the last card since the availability read.
    if (!stock) continue
    const snapshot = {
      ...quote.pricingSnapshot,
      fulfillment: {
        business: 'plus_50_percent_discount' as const,
        country,
        quote: offer.quotes[country],
      },
    }
    try {
      const checked = await preflight(
        openCredential(stock.code, 'inventory', stock.id),
        session,
        binding,
        'plus_50_percent_discount',
        country,
      )
      if (checked.status === 'ready') {
        validateFulfillment(checked, { ...quote, pricingSnapshot: snapshot })
        return { stock, checked, snapshot }
      }
    } catch (error) {
      // No redemption has been submitted. Only definitive upstream rejections
      // or validated mismatches may fall back; ambiguous failures remain errors.
      if (!(error instanceof ApiError) && !(error instanceof UpstreamError && !error.uncertain))
        throw error
    }
    await client.inventory.update({
      where: { id: stock.id },
      data: { status: 'available', reservedUntil: null },
    })
    // Bound upstream work: one optional preflight, then the normal route.
    return null
  }
  return null
}
