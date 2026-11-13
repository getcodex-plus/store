import { afterEach, describe, it, expect, vi } from 'vitest'
const resolveConfig = vi.hoisted(() =>
  vi.fn(async (_provider: string, revision?: string) => ({
    id: revision || 'current',
    url: revision === 'pinned' ? 'http://aicdk.internal:8080' : 'https://other.example',
    apiKey: 'test-only',
  })),
)
vi.mock('./config', () => ({ integration: resolveConfig }))
import { aicdk, preflight, UpstreamError } from './aicdk'
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
            data: { redemption_token: 'ticket', credential_type: 'chatgpt_session' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { status: 'ready', preflight_token: 'ready-token' } }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    expect(
      (await preflight('test-code', { user: { email: 'recharge@example.com' } }, 'pinned')).status,
    ).toBe('ready')
    expect(resolveConfig.mock.calls).toEqual([
      ['aicdk', 'pinned'],
      ['aicdk', 'pinned'],
    ])
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'http://aicdk.internal:8080/api/v1/redemptions/preview',
      'http://aicdk.internal:8080/api/v1/redemptions/preflight',
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
})
