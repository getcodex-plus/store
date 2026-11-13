import { db } from './db'
import { stringRecord } from './data'
import { integration } from './integrations/config'
import { ApiError, appUrl } from './config'
export type VerificationScene = 'login' | 'purchase'
export async function turnstilePublic() {
  const record = await db.integration.findFirst({
    where: { provider: 'turnstile', active: true },
    select: { public: true, enabled: true },
  })
  const config = record ? stringRecord(record.public) : {}
  return {
    siteKey: record?.enabled ? config.siteKey : '',
    login: !!record?.enabled && config.login === 'true',
    purchase: !!record?.enabled && config.purchase === 'true',
  }
}
export async function verifyTurnstileResult(
  secret: string,
  token: unknown,
  action: VerificationScene,
  hostname: string,
  request: typeof fetch = fetch,
) {
  if (typeof token !== 'string' || !token || token.length > 2048)
    throw new ApiError(403, '请先完成安全验证')
  try {
    const response = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('siteverify unavailable')
    const result = await response.json()
    if (result.success !== true || result.action !== action || result.hostname !== hostname)
      throw new Error('siteverify mismatch')
  } catch {
    throw new ApiError(403, '安全验证未通过或已过期，请重新验证')
  }
}
export async function requireTurnstile(scene: VerificationScene, token: unknown) {
  const config = await turnstilePublic()
  if (!config[scene]) return
  const privateConfig = await integration('turnstile')
  await verifyTurnstileResult(privateConfig.secret, token, scene, new URL(appUrl).hostname)
}
