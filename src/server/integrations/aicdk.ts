import { z } from 'zod'
import { ApiError } from '../config'
import { safeUpstreamError } from '../safe-errors'
import { integration } from './config'

export type AicdkBinding = string | Record<string, string>
export const resolveAicdk = (revision: string) => integration('aicdk', revision)
export const aicdkPlan = (plan: string) =>
  (({ pro5: 'pro_100', pro20: 'pro_200', promax: 'pro_500' }) as Record<string, string>)[plan] ??
  plan

export class UpstreamError extends Error {
  code: string
  retryAfter: number
  constructor(
    code: string,
    retryAfter: number,
    public uncertain: boolean,
    public status = 503,
  ) {
    const safe = safeUpstreamError({ code, retryAfter })
    super(safe.code)
    this.code = safe.code
    this.retryAfter = safe.retryAfter
  }
}

export async function aicdk<T>(
  path: string,
  body?: unknown,
  key?: string,
  binding?: AicdkBinding,
  method: 'GET' | 'POST' | 'PUT' = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const config = typeof binding === 'object' ? binding : await integration('aicdk', binding)
  const origin = config.url.replace(/\/$/, '')
  // HTTP is intentional for deployments on a trusted private network.
  if (!/^https?:\/\//.test(origin)) throw new ApiError(503, 'AICDK 地址需使用 HTTP 或 HTTPS')
  let response: Response
  let result: { ok?: boolean; data?: unknown; error?: { code?: unknown; uncertain?: unknown } }
  try {
    response = await fetch(`${origin}/api/v1${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 256_000) {
        await reader.cancel()
        throw new Error()
      }
      chunks.push(part.value)
    }
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!result || typeof result !== 'object') throw new Error()
  } catch {
    // Never retain response bodies, network error messages or request credentials.
    throw new UpstreamError('UPSTREAM_UNAVAILABLE', 30, true)
  }
  if (!response.ok || result.ok !== true) {
    const safe = safeUpstreamError({
      code: result.error?.code,
      retryAfter: Number(response.headers.get('Retry-After')) || 30,
    })
    throw new UpstreamError(
      safe.code,
      safe.retryAfter,
      result.error?.uncertain !== false,
      response.status,
    )
  }
  return result.data as T
}

const token = z.string().min(1).max(2048)
const email = z.email().max(254)
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/)
export const providerMoneySchema = z.object({
  amount_minor: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  currency_decimals: z.number().int().min(0).max(6).optional(),
})
export type ProviderMoney = z.infer<typeof providerMoneySchema>
const eligibility = z.object({
  eligible: z.boolean().nullable(),
  quote: providerMoneySchema.optional(),
})
const group = z.object({
  eligible: z.boolean().nullable(),
  plans: z.array(eligibility.extend({ id: z.string().min(1).max(64) })).max(32),
})
const accountCheckSchema = z.object({
  account_email: email,
  current_plan: z.string().max(64),
  account_status: z.enum(['active', 'deactivated']),
  subscription: z.object({
    purchase: group,
    offers: z
      .object({
        plus_50_percent_discount: z
          .object({
            eligible: z.boolean().nullable(),
            percent_off: z.literal(50),
            quotes: z.record(z.string().regex(/^[a-z]{2}$/), providerMoneySchema).optional(),
          })
          .optional(),
      })
      .optional()
      .catch(undefined),
  }),
})
export type AccountCheck = z.infer<typeof accountCheckSchema>
const redemptionQuote = providerMoneySchema.extend({
  current_plan: z.string().max(64).optional(),
  target_plan: z.string().min(1).max(64),
  business: z.string().min(1).max(64),
  billing_country: z.string().max(64).optional(),
})
const preflightSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pricing'),
    retry_after: z.number().int().min(1).max(86400).optional(),
  }),
  z.object({
    status: z.literal('ready'),
    preflight_token: token,
    account_email: email,
    current_plan: z.string().max(64).optional(),
    quote: redemptionQuote,
  }),
])
export type Preflight = z.infer<typeof preflightSchema>
const redemptionSchema = z.object({
  id: identifier,
  status: z
    .enum([
      'queued',
      'processing',
      'requires_action',
      'uncertain',
      'needs_session',
      'completed',
      'failed',
      'cancelled',
      'manual_review',
      'manual_processing',
      'submitting',
    ])
    .transform((value) =>
      value === 'manual_review'
        ? 'requires_action'
        : ['manual_processing', 'submitting'].includes(value)
          ? 'processing'
          : value,
    ),
  client_request_id: z.string().min(8).max(96),
  account_email: email,
  quote: redemptionQuote,
  version: z.number().int().nonnegative(),
})
export type Redemption = z.infer<typeof redemptionSchema>

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
  return result.data
}

export const replacementPreviewSchema = z.object({
  product_id: identifier,
  product_name: z.string().min(1).max(300),
  plan: z.string().max(64),
  expires_at: z.string().datetime({ offset: true }).nullable(),
})
const replacementResultSchema = replacementPreviewSchema
  .extend({
    id: identifier,
    old_code_id: identifier,
    new_code_id: identifier,
    new_code: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    secret_returned_once: z.boolean().optional(),
  })
  .refine((result) => result.old_code_id !== result.new_code_id)
  .refine((result) => !!result.new_code || result.secret_returned_once === true)

export async function previewReplacement(code: string, binding: AicdkBinding) {
  return validated(
    replacementPreviewSchema,
    await aicdk('/replacements/previews', { code }, undefined, binding),
  )
}

export async function replaceCode(code: string, key: string, binding: AicdkBinding) {
  return validated(replacementResultSchema, await aicdk('/replacements', { code }, key, binding))
}

export async function checkAccount(session: unknown, binding: AicdkBinding): Promise<AccountCheck> {
  return validated(
    accountCheckSchema,
    await aicdk('/account-checks', { session }, undefined, binding),
  )
}

export async function preflight(
  code: string,
  session: unknown,
  binding: AicdkBinding,
  expectedBusiness: 'upgrade' | 'recharge' | 'plus_50_percent_discount',
  expectedCountry?: string,
): Promise<Preflight> {
  const preview = validated(
    z.object({
      redemption_token: token,
      credential_type: z.literal('chatgpt_session'),
      business: z.string(),
      payment_country: z.string().max(64).optional(),
    }),
    await aicdk('/redemptions/previews', { code }, undefined, binding),
  )
  if (preview.business !== expectedBusiness)
    throw new ApiError(409, '兑换库存与业务类型不匹配，请联系支持')
  // AICDK exposes the card's region on preview; its public redemption quote
  // currently omits billing_country. Bind the actual card before authorization.
  if (
    expectedBusiness === 'plus_50_percent_discount' &&
    (!expectedCountry || preview.payment_country?.toLowerCase() !== expectedCountry)
  )
    throw new ApiError(409, '兑换地区与原订单不匹配，请联系支持核对')
  return validated(
    preflightSchema,
    await aicdk(
      '/redemptions/preflights',
      { redemption_token: preview.redemption_token, session },
      undefined,
      binding,
    ),
  )
}

export async function findRedemption(requestId: string, binding: AicdkBinding) {
  const results = validated(
    z.array(redemptionSchema).max(2),
    await aicdk(
      `/redemptions?client_request_id=${encodeURIComponent(requestId)}&limit=2`,
      undefined,
      undefined,
      binding,
    ),
  )
  // More than one redemption for the same client_request_id, or one that belongs
  // to a different request, means upstream already produced something we cannot
  // attribute. Resubmitting would produce yet another one, so this is a
  // definitive stop: callers mark the order for a human and never call upstream
  // again for it. (uncertain=false — retrying is exactly the wrong move here.)
  if (results.length > 1 || results.some((order) => order.client_request_id !== requestId))
    throw new UpstreamError('REDEMPTION_CONFLICT', 1, false)
  return results[0]
}

export async function getRedemption(orderId: string, binding: AicdkBinding) {
  const result = validated(
    redemptionSchema,
    await aicdk(`/redemptions/${encodeURIComponent(orderId)}`, undefined, undefined, binding),
  )
  if (result.id !== orderId) throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
  return result
}

export async function submitRedemption(
  preflightToken: string,
  requestId: string,
  key: string,
  binding: AicdkBinding,
) {
  return validated(
    redemptionSchema,
    await aicdk(
      '/redemptions',
      { preflight_token: preflightToken, client_request_id: requestId },
      key,
      binding,
    ),
  )
}

export async function updateAccountSession(
  orderId: string,
  session: unknown,
  key: string,
  binding: AicdkBinding,
) {
  const result = validated(
    redemptionSchema,
    await aicdk(
      `/redemptions/${encodeURIComponent(orderId)}/account-session`,
      { session },
      key,
      binding,
      'PUT',
    ),
  )
  if (result.id !== orderId) throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
  return result
}
