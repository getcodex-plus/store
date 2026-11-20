import type { PricingRules } from '../types'
import { costBasedPrice } from '../pricing'
import { ApiError } from './config'
import { supportedCurrency, type ExchangeRate } from './exchange-rates'
import {
  aicdkPlan,
  type ProviderMoney,
  type Preflight,
  type Redemption,
} from './integrations/aicdk'

export interface PricingSnapshot extends Partial<PricingRules> {
  mode: 'fixed' | 'markup'
  procurement?: { integrationId: string; upstreamProductId: number; skuId: number }
  providerQuote?: ProviderMoney
  rules?: PricingRules
  rateE8?: number
  exchangeRate?: ExchangeRate
  plusDiscount?: {
    quotes: Record<string, ProviderMoney>
    standardEligible: boolean
  }
  fulfillment?: {
    business: 'plus_50_percent_discount'
    country: string
    quote: ProviderMoney
  }
}
export interface FulfillmentQuote {
  email: string
  amount: number
  targetPlan?: string
  pricingSnapshot?: PricingSnapshot
}
export function fulfillmentBusiness(quote: FulfillmentQuote) {
  if (quote.pricingSnapshot?.fulfillment) {
    if (quote.targetPlan !== 'plus' || quote.pricingSnapshot.mode !== 'fixed')
      throw new ApiError(409, '兑换库存与订单业务类型不匹配，请联系支持')
    return quote.pricingSnapshot.fulfillment.business
  }
  return quote.pricingSnapshot?.mode === 'markup' ? 'upgrade' : 'recharge'
}
export function moneyDecimals(money: ProviderMoney) {
  if (!supportedCurrency(money.currency) || money.currency === 'USDT')
    throw new ApiError(503, '暂不支持此报价币种，请联系支持')
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: money.currency,
  }).resolvedOptions().maximumFractionDigits!
  if (money.currency_decimals !== undefined && money.currency_decimals !== digits)
    throw new ApiError(503, '上游报价币种精度不一致，请稍后重试')
  return digits
}
export function validateFulfillment(
  result: Extract<Preflight, { status: 'ready' }> | Redemption,
  quote: FulfillmentQuote,
  requestId?: string,
) {
  if (
    result.account_email.toLowerCase() !== quote.email.toLowerCase() ||
    !quote.targetPlan ||
    result.quote.target_plan !== aicdkPlan(quote.targetPlan) ||
    (requestId && (!('client_request_id' in result) || result.client_request_id !== requestId))
  )
    throw new ApiError(409, '兑换结果与原订单不匹配，请联系支持核对')
  const snapshot = quote.pricingSnapshot
  const upgrade = snapshot?.mode === 'markup'
  if (result.quote.business !== fulfillmentBusiness(quote))
    throw new ApiError(409, '兑换库存与订单业务类型不匹配，请联系支持')
  const selected = snapshot?.fulfillment
  if (selected) {
    // The preview already checked payment_country on the bound card. Public
    // quotes omit the region today; still reject a mismatch if it is returned.
    if (
      result.quote.billing_country !== undefined &&
      result.quote.billing_country.toLowerCase() !== selected.country
    )
      throw new ApiError(409, '兑换地区与原订单不匹配，请联系支持核对')
    if (
      result.quote.currency !== selected.quote.currency ||
      moneyDecimals(result.quote) !== moneyDecimals(selected.quote) ||
      result.quote.amount_minor > selected.quote.amount_minor
    )
      throw new ApiError(409, '兑换成本已变更，请重新检查账号；已付款请联系支持处理原订单')
  }
  if (upgrade) {
    const digits = moneyDecimals(result.quote)
    const currency = snapshot.providerQuote?.currency ?? 'USD'
    if (result.quote.currency !== currency)
      throw new ApiError(409, '兑换报价币种已变更，请联系支持核对原订单')
    const rules = snapshot.rules ?? (snapshot as PricingRules)
    const rateE8 = snapshot.rateE8 ?? snapshot.exchangeRate?.rateE8
    const currentPrice = costBasedPrice(result.quote.amount_minor, rules, rateE8, digits)
    if (currentPrice > quote.amount)
      throw new ApiError(409, '兑换成本已变更，请重新检查账号；已付款请联系支持处理原订单')
  }
}
