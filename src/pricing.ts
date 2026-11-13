import type { Channel, PricingRules, Settings } from './types'
import { channels, money } from './lib'

export const defaultPaymentLimits = {
  alipay: { min: 1, max: 200000 },
  wechat: { min: 1, max: 200000 },
  crypto: { min: 1, max: 100000000 },
} satisfies NonNullable<Settings['paymentLimits']>

export function paymentLimitError(settings: Settings, channel: Channel, amount: number) {
  if (channel === 'balance' || amount === 0) return ''
  const limits = settings.paymentLimits?.[channel] ?? defaultPaymentLimits[channel]
  return amount < limits.min || amount > limits.max
    ? `${channels[channel]}单笔支付范围为 ${money(limits.min)}–${money(limits.max)}，请调整余额抵扣或更换支付方式`
    : ''
}

export function costBasedPrice(usdCents: number, rules: PricingRules, automaticRateE8?: number) {
  const minimumProfit = rules.minimumProfit ?? 0
  const step = rules.roundingStep ?? 100
  if (
    !Number.isSafeInteger(usdCents) ||
    usdCents < 0 ||
    usdCents > 100000000 ||
    !Number.isSafeInteger(rules.fxRateBps) ||
    rules.fxRateBps <= 0 ||
    rules.fxRateBps > 1000000 ||
    !Number.isSafeInteger(rules.markupBps) ||
    rules.markupBps < 0 ||
    rules.markupBps > 100000 ||
    !Number.isSafeInteger(rules.serviceFee) ||
    rules.serviceFee < 0 ||
    rules.serviceFee > 100000000 ||
    !Number.isSafeInteger(rules.minimum) ||
    rules.minimum < 1 ||
    rules.minimum > 100000000 ||
    !Number.isSafeInteger(minimumProfit) ||
    minimumProfit < 0 ||
    minimumProfit > 100000000 ||
    ![1, 10, 100, 1000].includes(step)
  )
    throw new Error('成本报价或定价规则无效')
  const rateE8 = automaticRateE8 ?? rules.fxRateBps * 10000
  if (!Number.isSafeInteger(rateE8) || rateE8 <= 0 || rateE8 > 10000000000)
    throw new Error('汇率无效')
  const denominator = 1000000000000n
  const converted = BigInt(usdCents) * BigInt(rateE8) * BigInt(10000 + rules.markupBps)
  const cost = Number((BigInt(usdCents) * BigInt(rateE8) + 99999999n) / 100000000n)
  const unrounded = Math.max(
    Number((converted + denominator - 1n) / denominator) + rules.serviceFee,
    rules.minimum,
    cost + minimumProfit,
  )
  const amount = Math.ceil(unrounded / step) * step
  if (amount > 100000000) throw new Error('报价超出可交易范围')
  return amount
}

export function convertedSubscriptionPrice(
  usdCents: number,
  rateE8: number,
  roundingStep: PricingRules['roundingStep'] = 100,
) {
  return costBasedPrice(
    usdCents,
    {
      fxRateBps: 10000,
      markupBps: 0,
      serviceFee: 0,
      minimum: 1,
      roundingStep,
    },
    rateE8,
  )
}

export const roundingOptions = [
  { value: 1, label: '保留到分' },
  { value: 10, label: '向上进到角' },
  { value: 100, label: '向上取整到元' },
  { value: 1000, label: '向上取整到十元' },
]

export const planNames: Record<string, string> = {
  free: '免费套餐',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro5: 'ChatGPT Pro 100',
  pro20: 'ChatGPT Pro 200',
  promax: 'ChatGPT Pro 500',
}
