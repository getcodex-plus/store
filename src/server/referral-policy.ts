import { z } from 'zod'
import {
  usdtNetworks,
  validUsdtAddress,
  withdrawalDestinations,
  withdrawalFee,
} from '../withdrawals'

const withdrawalRuleSchema = z.object({
  minimum: z.number().int().min(100).max(100000000),
  feeRateBps: z.number().int().min(0).max(9999),
  fixedFee: z.number().int().min(0).max(100000000),
})

export const withdrawalChannelsSchema = z
  .object({
    alipay: z.boolean(),
    wechat: z.boolean(),
    usdt: z.boolean(),
    networks: z.object({
      TRC20: z.boolean(),
      ERC20: z.boolean(),
      BSC: z.boolean(),
      Polygon: z.boolean(),
    }),
    rules: z.object({
      alipay: withdrawalRuleSchema,
      wechat: withdrawalRuleSchema,
      TRC20: withdrawalRuleSchema,
      ERC20: withdrawalRuleSchema,
      BSC: withdrawalRuleSchema,
      Polygon: withdrawalRuleSchema,
    }),
  })
  .refine((value) => !value.usdt || Object.values(value.networks).some(Boolean), {
    path: ['networks'],
    message: '开启 USDT 提现时，请至少开启一个收款网络',
  })
  .superRefine((value, ctx) => {
    for (const { key, label } of withdrawalDestinations) {
      const rule = value.rules[key]
      if (withdrawalFee(rule.minimum, rule).netAmount <= 0)
        ctx.addIssue({
          code: 'custom',
          path: ['rules', key, 'fixedFee'],
          message: `${label}最低起提金额必须高于该金额对应的手续费`,
        })
    }
  })

export const referralTiersSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z\d_-]{1,32}$/),
      name: z.string().trim().min(1).max(20),
      minimumInvites: z.number().int().min(0).max(1000000),
      rateBps: z.number().int().min(0).max(900),
    }),
  )
  .length(4)
  .superRefine((tiers, ctx) => {
    if (!tiers.length) return
    if (tiers[0].minimumInvites !== 0)
      ctx.addIssue({
        code: 'custom',
        message: '第一级邀请门槛必须为 0 人',
        path: [0, 'minimumInvites'],
      })
    if (new Set(tiers.map((tier) => tier.id)).size !== tiers.length)
      ctx.addIssue({ code: 'custom', message: '邀请等级标识不能重复' })
    tiers.forEach((tier, index) => {
      if (!index) return
      if (tier.minimumInvites <= tiers[index - 1].minimumInvites)
        ctx.addIssue({
          code: 'custom',
          message: '各等级人数门槛必须逐级提高',
          path: [index, 'minimumInvites'],
        })
      if (tier.rateBps < tiers[index - 1].rateBps)
        ctx.addIssue({
          code: 'custom',
          message: '高等级返现比例不能低于前一级',
          path: [index, 'rateBps'],
        })
    })
  })

const withdrawalFields = {
  amount: z.number().int().positive().max(100000000),
  recipientName: z.string().trim().min(2, '请填写收款人姓名').max(80),
  account: z.string().trim().min(3, '请填写完整收款账号').max(250),
  requestKey: z.string().min(16).max(128),
  confirmed: z.literal(true, { error: '请核对并确认收款信息' }),
  expectedFeeAmount: z.number().int().min(0).max(100000000).default(0),
}
export const withdrawalSchema = z.discriminatedUnion('method', [
  z.object({
    ...withdrawalFields,
    method: z.enum(['支付宝', '微信']),
    network: z
      .null()
      .optional()
      .transform(() => null),
  }),
  z
    .object({
      ...withdrawalFields,
      method: z.literal('USDT'),
      network: z.enum(usdtNetworks, { error: '请选择 USDT 收款网络' }),
    })
    .superRefine((value, ctx) => {
      if (!validUsdtAddress(value.network, value.account))
        ctx.addIssue({
          code: 'custom',
          path: ['account'],
          message: '收款地址与所选网络格式不匹配，请重新核对',
        })
    }),
])

export const withdrawalReviewSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['processing', 'paid', 'rejected']),
    note: z.string().trim().max(300).default(''),
    payoutReference: z.string().trim().max(160).default(''),
    payoutAmount: z.number().positive().max(1000000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'rejected' && value.note.length < 3)
      ctx.addIssue({ code: 'custom', path: ['note'], message: '请填写拒绝原因，至少 3 个字' })
    if (value.status === 'paid' && value.payoutReference.length < 3)
      ctx.addIssue({
        code: 'custom',
        path: ['payoutReference'],
        message: '请填写实际打款流水号或链上交易哈希',
      })
  })
