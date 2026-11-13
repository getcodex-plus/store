import { headers } from 'next/headers'
import { auth } from './better-auth'
import { pool, rows } from './db'
import { requireRecent } from './auth'
import type { User } from '../types'
export async function securityStatus(user: User) {
  const totp =
    (await pool.query('SELECT id FROM "twoFactor" WHERE "userId"=$1 AND verified=true', [user.id]))
      .rowCount! > 0
  const password = !!(
    await pool.query(
      'SELECT id FROM auth_account WHERE "userId"=$1 AND "providerId"=\'credential\' AND password IS NOT NULL',
      [user.id],
    )
  ).rowCount
  return {
    password,
    totp,
    twoStepEnabled: (
      await pool.query('SELECT two_factor_enabled FROM users WHERE id=$1', [user.id])
    ).rows[0].two_factor_enabled,
    passkeys: await rows(
      'SELECT id,name,"createdAt" FROM auth_passkey WHERE "userId"=$1 ORDER BY "createdAt"',
      [user.id],
    ),
  }
}
export async function setPassword(user: User, password: string) {
  await requireRecent(user)
  await auth.api.setPassword({ headers: await headers(), body: { newPassword: password } })
  const session = await auth.api.getSession({ headers: await headers() })
  await pool.query('DELETE FROM auth_session WHERE "userId"=$1 AND token<>$2', [
    user.id,
    session!.session.token,
  ])
  return { saved: true }
}
