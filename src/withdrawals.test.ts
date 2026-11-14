import { describe, expect, it } from 'vitest'
import type { WithdrawalChannels } from './types'
import { withdrawalChannelsSchema } from './server/referral-policy'
import {
  defaultWithdrawalChannels,
  enabledWithdrawalMethods,
  lowestWithdrawalMinimum,
  withdrawalChannelError,
  withdrawalChannels,
  withdrawalFee,
  withdrawalRule,
  estimateUsdtAmount,
} from './withdrawals'

describe('withdrawal channels, minimums and fees', () => {
  it('uses default rules without enabling explicitly disabled destinations', () => {
    const defaults = withdrawalChannels({})
    expect(
      Object.values(defaults.rules).every(
        (rule) => rule.minimum === 5000 && rule.feeRateBps === 0 && rule.fixedFee === 0,
      ),
    ).toBe(true)
    const configured = withdrawalChannels({
      withdrawalChannels: {
        alipay: false,
        wechat: true,
        usdt: true,
        networks: { BSC: true },
        rules: { BSC: { minimum: 2500, feeRateBps: 150, fixedFee: 100 } },
      } as WithdrawalChannels,
    })
    expect(configured.alipay).toBe(false)
    expect(configured.networks).toEqual({ BSC: true, Polygon: false, ERC20: false, TRC20: false })
    expect(configured.rules.BSC).toEqual({ minimum: 2500, feeRateBps: 150, fixedFee: 100 })
    expect(configured.rules.wechat.minimum).toBe(5000)
    expect(withdrawalChannels({ withdrawalChannels: configured })).toEqual(configured)
  })

  it('uses only enabled withdrawal destinations, independently of purchase payment switches', () => {
    const config = structuredClone(defaultWithdrawalChannels)
    config.alipay = false
    config.wechat = false
    config.networks = { ERC20: false, TRC20: false, BSC: true, Polygon: true }
    config.rules.BSC.minimum = 2500
    config.rules.Polygon.minimum = 1500
    config.rules.alipay.minimum = 100
    const settings = { withdrawalChannels: config, alipay: false, wechat: false, crypto: false }
    expect(enabledWithdrawalMethods(settings).map((method) => method.value)).toEqual(['USDT'])
    expect(lowestWithdrawalMinimum(settings)).toBe(1500)
    expect(withdrawalRule(settings, 'USDT', 'BSC')?.minimum).toBe(2500)
    expect(withdrawalRule(settings, 'USDT')).toBeNull()
    expect(withdrawalChannelError(settings, '支付宝')).toContain('渠道暂未开放')
    expect(withdrawalChannelError(settings, 'USDT', 'ERC20')).toContain('网络暂未开放')
    expect(withdrawalChannelError(settings, 'USDT', 'Polygon')).toBe('')
    config.usdt = false
    expect(enabledWithdrawalMethods(settings)).toHaveLength(0)
    expect(lowestWithdrawalMinimum(settings)).toBeNull()
  })

  it.each([
    [10000, 0, 0, 0, 10000],
    [10000, 250, 0, 250, 9750],
    [10000, 0, 100, 100, 9900],
    [10001, 250, 100, 350, 9651],
    [100, 50, 0, 1, 99],
    [100, 49, 0, 0, 100],
    [100000000, 9999, 0, 99990000, 10000],
  ])(
    'quotes integer cents for amount %i at %i bps plus %i',
    (amount, feeRateBps, fixedFee, feeAmount, netAmount) => {
      expect(withdrawalFee(amount, { feeRateBps, fixedFee })).toEqual({
        feeAmount,
        netAmount,
        feeRateBps,
        fixedFee,
      })
    },
  )

  it('requires complete valid rules and a positive payout at every minimum', () => {
    expect(withdrawalChannelsSchema.safeParse(defaultWithdrawalChannels).success).toBe(true)
    for (const change of [
      { minimum: 99 },
      { minimum: 100.1 },
      { feeRateBps: -1 },
      { feeRateBps: 10000 },
      { feeRateBps: 1.5 },
      { fixedFee: -1 },
      { fixedFee: 5000 },
      { feeRateBps: 5000, fixedFee: 2500 },
    ]) {
      const config = structuredClone(defaultWithdrawalChannels)
      Object.assign(config.rules.BSC, change)
      expect(withdrawalChannelsSchema.safeParse(config).success).toBe(false)
    }
    const config = structuredClone(defaultWithdrawalChannels)
    config.networks = { ERC20: false, TRC20: false, BSC: false, Polygon: false }
    expect(withdrawalChannelsSchema.safeParse(config).success).toBe(false)
    config.usdt = false
    expect(withdrawalChannelsSchema.safeParse(config).success).toBe(true)
    expect(withdrawalChannelsSchema.safeParse({ ...config, rules: {} }).success).toBe(false)
  })

  it('converts net CNY to USDT with six-decimal rounding and rejects unusable amounts', () => {
    expect(estimateUsdtAmount(9700, 700000000)).toBe('13.857143')
    expect(estimateUsdtAmount(10000, 625000000)).toBe('16.000000')
    expect(estimateUsdtAmount(1, 600000000)).toBe('0.001667')
    expect(estimateUsdtAmount(100000000, 100000000)).toBe('1000000.000000')
    for (const [amount, rate] of [
      [0, 700000000],
      [-1, 700000000],
      [1.5, 700000000],
      [100, 0],
      [100, NaN],
      [100, 1],
      [100000001, 700000000],
      [100, 10000000001],
    ])
      expect(() => estimateUsdtAmount(amount, rate)).toThrow('INVALID_PAYOUT_ESTIMATE')
  })
})
