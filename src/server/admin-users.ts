import { z } from 'zod'
import type { User } from '../types'
import { defaultReferralTiers } from '../referral'
import { ApiError } from './config'
import { transaction } from './db'
import { lockRow, lockSettings } from './database-sql'
import { settingsData } from './data'
import { authorize } from './rbac'
import { audit } from './services'

const updateUserSchema = z
  .object({
    id: z.string().min(1),
    disabled: z.boolean().optional(),
    referralTierId: z
      .string()
      .regex(/^[a-z\d_-]{1,32}$/)
      .nullable()
      .optional(),
  })
  .refine((input) => input.disabled !== undefined || input.referralTierId !== undefined, {
    message: '请选择要修改的用户信息',
  })

export async function updateAdminUser(admin: User, data: unknown) {
  authorize(admin, 'users:write')
  const input = updateUserSchema.parse(data)
  return transaction(async (client) => {
    await lockRow(client, 'users', input.id)
    const user = await client.user.findUnique({ where: { id: input.id } })
    if (!user) throw new ApiError(404, '用户不存在')
    if (input.disabled !== undefined && (user.role === 'admin' || user.id === admin.id))
      throw new ApiError(400, '不能修改受保护管理员的停用状态')
    let tierName = '自动计算'
    if (input.referralTierId != null) {
      await lockSettings(client, 'share')
      const record = await client.setting.findUnique({ where: { id: 1 } })
      if (!record) throw new ApiError(503, '请先初始化数据库')
      const tiers = settingsData(record.body).referralTiers ?? defaultReferralTiers
      const tier = tiers.find((entry) => entry.id === input.referralTierId)
      if (!tier) throw new ApiError(400, '返佣等级不存在，请刷新后重新选择')
      tierName = tier.name
    }
    await client.user.update({
      where: { id: input.id },
      data: {
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        ...(input.referralTierId !== undefined ? { referralTierId: input.referralTierId } : {}),
      },
    })
    if (input.disabled) await client.authSession.deleteMany({ where: { userId: input.id } })
    if (input.disabled !== undefined)
      await audit(admin.email, input.disabled ? '停用用户' : '启用用户', input.id, client)
    if (input.referralTierId !== undefined)
      await audit(admin.email, `修改返佣等级：${tierName}`, input.id, client)
    return { saved: true }
  })
}
