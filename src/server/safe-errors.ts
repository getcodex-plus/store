// Upstream strings are untrusted, even when supplied as an error "code".
// Only this fixed vocabulary may reach an API response or the job table.
export function safeUpstreamError(error: { code: unknown; retryAfter: unknown }) {
  const codes = [
    'PREFLIGHT_EXPIRED',
    'OUTCOME_UNKNOWN',
    'IDEMPOTENCY_CONFLICT',
    'CDK_LOCKED',
    'ACCOUNT_QUERY_UNAVAILABLE',
    'ACCOUNT_QUERY_RATE_LIMITED',
    'ACCOUNT_QUERY_CONFIGURATION',
    'ACCOUNT_QUERY_REJECTED',
    'SESSION_TOKEN_EXPIRED',
    'ACCOUNT_DEACTIVATED',
    'REGION_NOT_SUPPORTED',
    'PRODUCT_DISABLED',
    'PRODUCT_CLOSED',
    'IP_NOT_ALLOWED',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_INVALID_RESPONSE',
    'PRICE_REFRESH_PENDING',
    'CATALOG_REFRESH_PENDING',
    'OPERATION_NOT_READY',
    'NOT_FOUND',
  ]
  return {
    code:
      typeof error.code === 'string' && codes.includes(error.code) ? error.code : 'UPSTREAM_ERROR',
    retryAfter:
      typeof error.retryAfter === 'number' &&
      Number.isInteger(error.retryAfter) &&
      error.retryAfter >= 1 &&
      error.retryAfter <= 86400
        ? error.retryAfter
        : 30,
  }
}

export function publicPlan(value: unknown): string | undefined {
  if (value === 'pro_100') return 'pro5'
  if (value === 'pro_200') return 'pro20'
  if (value === 'pro_500') return 'promax'
  return typeof value === 'string' &&
    [
      'free',
      'go',
      'plus',
      'pro',
      'pro5',
      'pro20',
      'promax',
      'team',
      'business',
      'enterprise',
      'edu',
    ].includes(value)
    ? value
    : undefined
}
