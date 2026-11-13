import type { PricingRules } from '../types'
import { costBasedPrice } from '../pricing'
import { ApiError } from './config'
import { exchangeRate, supportedCurrency, type ExchangeRate } from './exchange-rates'
import {
  aicdkPlan,
  type ProviderMoney,
  type Preflight,
  type Redemption,
} from './integrations/aicdk'

export interface PricingSnapshot extends Partial<PricingRules> {
  mode: 'fixed' | 'markup'
  providerQuote?: ProviderMoney
  rules?: PricingRules
  rateE8?: number
  exchangeRate?: ExchangeRate
}
export interface FulfillmentQuote {
  email: string
  amount: number
  targetPlan?: string
  pricingSnapshot?: PricingSnapshot
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
export async function priceReference(
  money: ProviderMoney,
  rules: PricingRules,
  mode: 'auto' | 'manual',
) {
  const digits = moneyDecimals(money)
  // A manual USD/CNY setting must never be applied to JPY/EUR/etc.
  const rate =
    money.currency === 'USD' && mode === 'manual'
      ? undefined
      : await exchangeRate(true, money.currency)
  const rateE8 = rate?.rateE8 ?? rules.fxRateBps * 10000
  return {
    amount: costBasedPrice(money.amount_minor, rules, rateE8, digits),
    rate,
    snapshot: {
      mode: 'markup' as const,
      providerQuote: { ...money, currency_decimals: digits },
      rules,
      rateE8,
      exchangeRate: rate,
    },
  }
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
  if (result.quote.business !== (upgrade ? 'upgrade' : 'recharge'))
    throw new ApiError(409, '兑换库存与订单业务类型不匹配，请联系支持')
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
