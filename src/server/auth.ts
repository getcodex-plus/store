import { cookies, headers } from 'next/headers'
import { pool, rows } from './db'
import { ApiError, demo } from './config'
import { hash, id } from './crypto'
import type { User } from '../types'
import { permissionsFor } from './rbac'
import { auth, permittedSession } from './better-auth'

export async function currentUser(): Promise<User | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return null
  const record = (
    await rows<User & { twoFactorEnabled: boolean; hasPasskey: boolean; hasTotp: boolean }>(
      'SELECT u.*,EXISTS(SELECT 1 FROM auth_passkey p WHERE p."userId"=u.id) AS has_passkey,EXISTS(SELECT 1 FROM "twoFactor" t WHERE t."userId"=u.id AND t.verified=true) AS has_totp FROM users u WHERE u.id=$1 AND disabled=false',
      [session.user.id],
    )
  )[0]
  if (
    !record ||
    !permittedSession(
      session.session.method || 'unknown',
      record.hasPasskey,
      record.twoFactorEnabled,
      record.hasTotp,
    )
  )
    return null
  if (session.user.emailVerified)
    await pool.query(
      'UPDATE orders SET user_id=$1,guest_browser_digest=null WHERE user_id IS NULL AND contact_email=$2',
      [record.id, record.email],
    )
  return { ...record, permissions: await permissionsFor(record) }
}
export async function requireUser(admin = false): Promise<User> {
  const user = await currentUser()
  if (!user) throw new ApiError(401, '请先登录并完成所需验证')
  if (admin && !user.permissions.includes('admin:access')) throw new ApiError(403, '需要管理员权限')
  return user
}
export async function requireRecent(user: User) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (
    !session ||
    session.user.id !== user.id ||
    Date.now() - new Date(session.session.createdAt).getTime() > 600000
  )
    throw new ApiError(403, '请重新登录后执行此敏感操作（需要最近 10 分钟内验证）')
}
export async function browserDigest(): Promise<string> {
  const jar = await cookies()
  let token = jar.get('getgpt_browser')?.value
  if (!token) {
    token = id()
    jar.set('getgpt_browser', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !demo,
      path: '/',
      maxAge: 86400 * 30,
    })
  }
  return hash(token)
}
export { rateLimit } from './rate-limit'
