'use client'
import { createAuthClient } from 'better-auth/react'
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'
export const authClient = createAuthClient({
  plugins: [emailOTPClient(), twoFactorClient(), passkeyClient()],
})
export function authResult<T>(result: { data: T | null; error: { message?: string } | null }): T {
  if (result.error) throw new Error(result.error.message || '验证未完成，请重试')
  return result.data as T
}
