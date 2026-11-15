import { z } from 'zod'

// Shared by the settings form and API so both enforce the same tier rules.
export const referralTiersSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z\d_-]{1,32}$/),
      name: z.string().trim().min(1, '请填写等级名称').max(20),
      minimumInvites: z.number().int().min(0).max(1000000),
      rateBps: z.number().int().min(0).max(900),
    }),
  )
  .min(1, '请至少保留一个返利等级')
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
