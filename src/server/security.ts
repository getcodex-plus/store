import { db } from './db'
import type { User } from '../types'
export async function securityStatus(user: User) {
  const [totp, credential, owner, passkeys] = await Promise.all([
    db.twoFactor.count({ where: { userId: user.id, verified: true } }),
    db.authAccount.count({
      where: { userId: user.id, providerId: 'opaque', registrationRecord: { not: null } },
    }),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { twoFactorEnabled: true } }),
    db.authPasskey.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  return {
    password: credential > 0,
    totp: totp > 0,
    twoStepEnabled: !!owner.twoFactorEnabled,
    passkeys: passkeys.map((p) => ({ ...p, createdAt: p.createdAt?.toISOString() ?? null })),
  }
}
