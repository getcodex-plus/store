import { afterEach, describe, it, expect, vi } from 'vitest'
const resolveConfig = vi.hoisted(() =>
  vi.fn(async (_provider: string, revision?: string) => ({
    id: revision || 'current',
    url: revision === 'pinned' ? 'http://aicdk.internal:8080' : 'https://other.example',
    apiKey: 'test-only',
  })),
)
vi.mock('./config', () => ({ integration: resolveConfig }))
import {
  aicdk,
  checkAccount,
  preflight,
  findRedemption,
  getRedemption,
  updateAccountSession,
  UpstreamError,
} from './aicdk'
const session = {
  user: { email: 'recharge@example.com' },
  accessToken: 'test-access',
  sessionToken: 'test-session',
  extra: { requiredByProvider: true },
}
const quote = {
  amount_minor: 1000,
  currency: 'USD',
  currency_decimals: 2,
  business: 'upgrade',
  target_plan: 'pro_200',
}
const redemption = {
  id: 'ord_test',
  client_request_id: 'o_localtest',
  account_email: session.user.email,
  quote,
  version: 1,
  status: 'queued',
}
const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data, request_id: 'trace_test' }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('AICDK transport and config binding', () => {
  it('pins both preflight calls to the same internal HTTP instance and forbids redirects', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              redemption_token: 'ticket',
              credential_type: 'chatgpt_session',
              business: 'upgrade',
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: 'ready',
              preflight_token: 'ready-token',
              account_email: session.user.email,
              quote,
            },
          }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    expect((await preflight('test-code', session, 'pinned', 'upgrade')).status).toBe('ready')
    expect(resolveConfig.mock.calls).toEqual([
      ['aicdk', 'pinned'],
      ['aicdk', 'pinned'],
    ])
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'http://aicdk.internal:8080/api/v1/redemptions/previews',
      'http://aicdk.internal:8080/api/v1/redemptions/preflights',
    ])
    expect(fetcher.mock.calls.every((call) => call[1].redirect === 'error')).toBe(true)
  })
  it('preserves stable idempotency keys and distinguishes definitive preflight expiry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: { code: 'PREFLIGHT_EXPIRED', uncertain: false } }),
          { status: 409, headers: { 'Retry-After': '30' } },
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    const result = await aicdk(
      '/redemptions',
      { preflight_token: 'test' },
      'stable-order-v0',
      'pinned',
    ).catch((error) => error)
    expect(result).toBeInstanceOf(UpstreamError)
    if (!(result instanceof UpstreamError)) throw new Error('Expected upstream error')
    expect(result.code).toBe('PREFLIGHT_EXPIRED')
    expect(result.uncertain).toBe(false)
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe('stable-order-v0')
  })
  it('checks accounts with a complete Session and no code, preview or idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      ok({
        account_email: session.user.email,
        current_plan: 'plus',
        account_status: 'active',
        subscription: {
          purchase: { eligible: false, plans: [] },
          upgrade: { eligible: true, plans: [{ id: 'pro_200', eligible: true, quote }] },
        },
        secret: 'must-not-be-returned',
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await checkAccount(session, 'pinned')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('http://aicdk.internal:8080/api/v1/account-checks')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ session })
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Idempotency-Key')
    expect(result).not.toHaveProperty('secret')
  })
  it('refreshes the same redemption using PUT and preserves its idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(redemption))
    vi.stubGlobal('fetch', fetcher)
    await updateAccountSession(redemption.id, session, 'saved-session-key', 'pinned')
    expect(fetcher.mock.calls[0][0]).toBe(
      'http://aicdk.internal:8080/api/v1/redemptions/ord_test/account-session',
    )
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Idempotency-Key': 'saved-session-key' },
    })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ session })
  })
  it('rejects ambiguous or mismatched recovery results and never trusts an arbitrary order id', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([redemption, redemption]))
      .mockResolvedValueOnce(ok([{ ...redemption, client_request_id: 'o_someoneelse' }]))
      .mockResolvedValueOnce(ok({ ...redemption, id: 'ord_other' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(findRedemption(redemption.client_request_id, 'pinned')).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    })
    await expect(findRedemption(redemption.client_request_id, 'pinned')).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    })
    await expect(getRedemption(redemption.id, 'pinned')).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    })
  })
  it('does not allow a pending preflight token to become a submission authorization', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          redemption_token: 'preview',
          credential_type: 'chatgpt_session',
          business: 'upgrade',
        }),
      )
      .mockResolvedValueOnce(
        ok({ status: 'pricing', preflight_token: 'not-ready', retry_after: 2 }),
      )
    vi.stubGlobal('fetch', fetcher)
    expect(await preflight('test-code', session, 'pinned', 'upgrade')).toEqual({
      status: 'pricing',
      retry_after: 2,
    })
  })
  it('redacts arbitrary upstream strings and treats network errors as uncertain', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'private-card-code', message: 'private-session', uncertain: false },
          }),
          { status: 422 },
        ),
      )
      .mockRejectedValueOnce(new Error('private-card-code'))
      .mockResolvedValueOnce(new Response('private-session-not-json'))
    vi.stubGlobal('fetch', fetcher)
    for (const expected of ['UPSTREAM_ERROR', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE']) {
      const error = await aicdk('/redemptions', {}, 'stable-key', 'pinned').catch((error) => error)
      if (!(error instanceof UpstreamError)) throw new Error('Expected upstream error')
      expect(error.code).toBe(expected)
      expect(String(error)).not.toContain('private')
      if (expected !== 'UPSTREAM_ERROR') expect(error.uncertain).toBe(true)
    }
  })
  it('accepts manual fulfillment states as nonterminal and keeps rate-limit delays', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...redemption, status: 'manual_review' }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'ACCOUNT_QUERY_RATE_LIMITED', uncertain: false },
          }),
          { status: 429, headers: { 'Retry-After': '900' } },
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    expect((await getRedemption(redemption.id, 'pinned')).status).toBe('requires_action')
    await expect(checkAccount(session, 'pinned')).rejects.toMatchObject({
      status: 429,
      retryAfter: 900,
      uncertain: false,
    })
  })
})
