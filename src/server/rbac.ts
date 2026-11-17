import { ApiError } from './config'
import { db } from './db'
import { z } from 'zod'
import type { User } from '../types'

export const permissions = [
  'admin:access',
  'orders:read',
  'orders:write',
  'products:read',
  'products:write',
  'coupons:read',
  'coupons:write',
  'users:read',
  'users:write',
  'wallet:read',
  'referral:read',
  'withdrawals:read',
  'withdrawals:write',
  'integrations:read',
  'integrations:write',
  'settings:read',
  'settings:write',
  'audit:read',
  'roles:read',
  'roles:write',
] as const
export type Permission = (typeof permissions)[number]
export async function permissionsFor(user: Pick<User, 'id' | 'role'>): Promise<string[]> {
  if (user.role === 'admin') return [...permissions]
  const roles = await db.userRole.findMany({
    where: { userId: user.id },
    select: { role: { select: { permissions: true } } },
  })
  return [...new Set(roles.flatMap((r) => z.array(z.string()).parse(r.role.permissions)))]
}
export function authorize(user: User, permission: Permission) {
  if (!user.permissions.includes(permission)) throw new ApiError(403, '当前角色没有此操作权限')
}
export function mayGrant(actor: User, requested: string[]) {
  if (requested.some((permission) => !actor.permissions.includes(permission)))
    throw new ApiError(403, '不能授予自己没有的权限')
}
