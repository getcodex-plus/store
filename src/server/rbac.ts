import { ApiError } from './config'
import { pool } from './db'
import type { User } from '../types'

export const permissions = [
  'admin:access',
  'orders:read',
  'orders:write',
  'products:read',
  'products:write',
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
  const result = await pool.query(
    'SELECT r.permissions FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1',
    [user.id],
  )
  return [...new Set(result.rows.flatMap((r) => r.permissions as string[]))]
}
export function authorize(user: User, permission: Permission) {
  if (!user.permissions.includes(permission)) throw new ApiError(403, '当前角色没有此操作权限')
}
export function mayGrant(actor: User, requested: string[]) {
  if (requested.some((permission) => !actor.permissions.includes(permission)))
    throw new ApiError(403, '不能授予自己没有的权限')
}
