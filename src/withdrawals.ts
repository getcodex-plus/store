import type {
  Settings,
  WithdrawalChannels,
  WithdrawalDestination,
  WithdrawalNetwork,
  WithdrawalRule,
} from './types'

export const withdrawalMethods = [
  { key: 'alipay', value: '支付宝', label: '支付宝' },
  { key: 'wechat', value: '微信', label: '微信' },
  { key: 'usdt', value: 'USDT', label: 'USDT' },
] as const

export const usdtNetworks = ['ERC20', 'TRC20', 'BSC', 'Polygon'] as const
export const usdtNetworkLabels: Record<WithdrawalNetwork, string> = {
  TRC20: 'Tron',
  ERC20: 'Ethereum',
  BSC: 'BNB Smart Chain',
  Polygon: 'Polygon',
}
export const withdrawalDestinations: {
  key: WithdrawalDestination
  label: string
  method: string
  network: WithdrawalNetwork | null
}[] = [
  { key: 'alipay', label: '支付宝', method: '支付宝', network: null },
  { key: 'wechat', label: '微信', method: '微信', network: null },
  ...usdtNetworks.map((network) => ({
    key: network,
    label: usdtNetworkLabels[network],
    method: 'USDT',
    network,
  })),
]
function defaultRules(minimum: number): WithdrawalChannels['rules'] {
  return Object.fromEntries(
    withdrawalDestinations.map(({ key }) => [key, { minimum, feeRateBps: 0, fixedFee: 0 }]),
  ) as WithdrawalChannels['rules']
}
export const defaultWithdrawalChannels: WithdrawalChannels = {
  alipay: true,
  wechat: true,
  usdt: true,
  networks: { TRC20: true, ERC20: true, BSC: true, Polygon: true },
  rules: defaultRules(5000),
}

type WithdrawalSettings = Pick<Settings, 'withdrawalChannels'>

export function withdrawalChannels(settings: WithdrawalSettings): WithdrawalChannels {
  const value = settings.withdrawalChannels ?? defaultWithdrawalChannels
  const fallback = defaultWithdrawalChannels.rules
  return {
    alipay: value.alipay === true,
    wechat: value.wechat === true,
    usdt: value.usdt === true,
    networks: {
      TRC20: value.networks?.TRC20 === true,
      ERC20: value.networks?.ERC20 === true,
      BSC: value.networks?.BSC === true,
      Polygon: value.networks?.Polygon === true,
    },
    rules: Object.fromEntries(
      withdrawalDestinations.map(({ key }) => [
        key,
        { ...fallback[key], ...settings.withdrawalChannels?.rules?.[key] },
      ]),
    ) as WithdrawalChannels['rules'],
  }
}

export function enabledWithdrawalMethods(settings: WithdrawalSettings) {
  const configured = withdrawalChannels(settings)
  return withdrawalMethods.filter(
    (method) =>
      configured[method.key] &&
      (method.key !== 'usdt' || usdtNetworks.some((network) => configured.networks[network])),
  )
}

export function withdrawalChannelError(
  settings: WithdrawalSettings,
  method: string,
  network?: WithdrawalNetwork | null,
) {
  const configured = withdrawalChannels(settings)
  if (!enabledWithdrawalMethods(settings).some((option) => option.value === method))
    return '此提现渠道暂未开放，请选择其他收款方式'
  if (method === 'USDT' && (!network || !configured.networks[network]))
    return '此 USDT 收款网络暂未开放，请选择其他网络'
  return ''
}

export function withdrawalRule(
  settings: WithdrawalSettings,
  method?: string,
  network?: WithdrawalNetwork | null,
): WithdrawalRule | null {
  const destination = withdrawalDestinations.find(
    (entry) => entry.method === method && (method !== 'USDT' || entry.network === network),
  )
  return destination ? withdrawalChannels(settings).rules[destination.key] : null
}

export function lowestWithdrawalMinimum(settings: WithdrawalSettings): number | null {
  const configured = withdrawalChannels(settings)
  const minimums = withdrawalDestinations
    .filter(({ method, network }) => !withdrawalChannelError(settings, method, network))
    .map(({ key }) => configured.rules[key].minimum)
  return minimums.length ? Math.min(...minimums) : null
}

export function withdrawalFee(
  amount: number,
  rule: Pick<WithdrawalRule, 'feeRateBps' | 'fixedFee'>,
) {
  // Amounts are integer CNY cents; round the percentage component half up.
  const feeAmount = Math.floor((amount * rule.feeRateBps + 5000) / 10000) + rule.fixedFee
  return {
    feeAmount,
    netAmount: amount - feeAmount,
    feeRateBps: rule.feeRateBps,
    fixedFee: rule.fixedFee,
  }
}

export function estimateUsdtAmount(netAmount: number, rateE8: number): string {
  if (
    !Number.isSafeInteger(netAmount) ||
    netAmount <= 0 ||
    netAmount > 100000000 ||
    !Number.isSafeInteger(rateE8) ||
    rateE8 <= 0 ||
    rateE8 > 10000000000
  )
    throw new Error('INVALID_PAYOUT_ESTIMATE')
  // CNY cents / (CNY per USDT) -> USDT millionths, rounded half up.
  const divisor = BigInt(rateE8)
  const millionths = (BigInt(netAmount) * 1000000000000n + divisor / 2n) / divisor
  if (millionths <= 0n || millionths > 1000000000000n) throw new Error('INVALID_PAYOUT_ESTIMATE')
  return `${millionths / 1000000n}.${(millionths % 1000000n).toString().padStart(6, '0')}`
}

export function validUsdtAddress(network: WithdrawalNetwork, address: string) {
  if (!usdtNetworks.includes(network)) return false
  return (network === 'TRC20' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/ : /^0x[a-fA-F0-9]{40}$/).test(
    address.trim(),
  )
}
