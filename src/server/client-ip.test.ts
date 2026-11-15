import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Shared client IP policy', () => {
  beforeEach(() => {
    // Better Auth captures NODE_ENV when its environment module is loaded.
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TEST', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('uses X-Forwarded-For even when the legacy proxy switch is disabled', async () => {
    vi.stubEnv('TRUST_PROXY', 'false')
    const { clientIP } = await import('./client-ip')
    expect(
      clientIP(new Headers({ 'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2' })),
    ).toBe('192.0.2.1')
  })

  it.each<Record<string, string>>([
    {},
    { 'x-real-ip': '192.0.2.1' },
    { 'x-forwarded-for': '' },
    { 'x-forwarded-for': 'invalid' },
    { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' },
    { 'x-forwarded-for': 'fe80::1%en0' },
  ])('leaves missing or unusable production IPs unknown: %j', async (headers) => {
    const { clientIP } = await import('./client-ip')
    expect(clientIP(new Headers(headers))).toBeUndefined()
  })

  it.each([
    [' 192.0.2.1 ', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['2001:DB8:1234:5678:abcd::1', '2001:0db8:1234:5678:0000:0000:0000:0000'],
  ])('normalizes %s using the authentication policy', async (value, expected) => {
    const { clientIP } = await import('./client-ip')
    expect(clientIP(new Headers({ 'x-forwarded-for': value }))).toBe(expected)
  })

  it('keeps Better Auth’s test environment localhost fallback', async () => {
    vi.stubEnv('TEST', 'true')
    const { clientIP } = await import('./client-ip')
    expect(clientIP(new Headers())).toBe('127.0.0.1')
  })
})
