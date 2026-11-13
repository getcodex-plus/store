import { ApiError } from '../config'
import { integration } from './config'

export class UpstreamError extends Error {
  constructor(
    public code: string,
    public retryAfter: number,
    public uncertain: boolean,
  ) {
    super(code)
  }
}
export async function aicdk<T>(
  path: string,
  body?: unknown,
  key?: string,
  revision?: string,
): Promise<T> {
  const config = await integration('aicdk', revision)
  const origin = config.url.replace(/\/$/, '')
  if (!/^https?:\/\//.test(origin)) throw new ApiError(503, 'AICDK 地址需使用 HTTP 或 HTTPS')
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
  })
  const result = await response.json()
  if (!response.ok || !result.ok)
    throw new UpstreamError(
      result.error?.code || 'UPSTREAM_ERROR',
      Number(response.headers.get('Retry-After')) || 30,
      result.error?.uncertain === true,
    )
  return result.data as T
}
export interface Preflight {
  status: 'ready' | 'pricing'
  preflight_token?: string
  retry_after?: number
  account_email?: string
  currentPlan?: string
  quote?: {
    payment_usd_cents?: number
    current_plan?: string
    target_plan?: string
    business?: string
  }
}
export async function preflight(
  code: string,
  session: unknown,
  revision?: string,
): Promise<Preflight> {
  const preview = await aicdk<{ redemption_token: string; credential_type: string }>(
    '/redemptions/preview',
    { code },
    undefined,
    revision,
  )
  if (preview.credential_type !== 'chatgpt_session')
    throw new ApiError(409, '此商品暂不支持当前账号验证方式')
  return aicdk<Preflight>(
    '/redemptions/preflight',
    {
      redemption_token: preview.redemption_token,
      session,
    },
    undefined,
    revision,
  )
}
