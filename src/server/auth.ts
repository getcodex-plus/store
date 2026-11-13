import { cookies, headers } from 'next/headers'
import { db } from './db'
import { userView } from './data'
import { ApiError, demo } from './config'
import { hash, id } from './crypto'
import type { User } from '../types'
import { permissionsFor } from './rbac'
import { auth, permittedSession } from './better-auth'

export async function currentUser(): Promise<User | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return null
  const record = await db.user.findFirst({
    where: { id: session.user.id, disabled: false },
    include: {
      passkeys: { select: { id: true } },
      twoFactors: { where: { verified: true }, select: { id: true } },
    },
  })
  if (
    !record ||
    !permittedSession(
      session.session.method || 'unknown',
      record.passkeys.length > 0,
      !!record.twoFactorEnabled,
      record.twoFactors.length > 0,
    )
  )
    return null
  if (session.user.emailVerified)
    await db.order.updateMany({
      where: { userId: null, contactEmail: record.email },
      data: { userId: record.id, guestBrowserDigest: null },
    })
  const user = userView(record)
  return { ...user, permissions: await permissionsFor(user) }
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
