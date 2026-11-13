import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'
afterEach(() => vi.unstubAllEnvs())
it('uses an unpredictable per-request nonce and overwrites caller supplied CSP headers', () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('APP_MODE', 'live')
  const request = new NextRequest('https://shop.example/admin', {
    headers: { 'x-nonce': 'attacker', 'Content-Security-Policy': "script-src * 'unsafe-inline'" },
  })
  const first = proxy(request),
    second = proxy(request)
  const policy = first.headers.get('Content-Security-Policy')!
  expect(policy).not.toContain('attacker')
  expect(policy).not.toContain("'unsafe-eval'")
  expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain("'unsafe-inline'")
  expect(policy).toContain("script-src-attr 'none'")
  expect(policy).toContain("base-uri 'none'")
  expect(policy).toContain('upgrade-insecure-requests')
  expect(policy).toContain(`'nonce-${first.headers.get('x-middleware-request-x-nonce')}'`)
  expect(policy).not.toBe(second.headers.get('Content-Security-Policy'))
  expect(first.headers.get('Cache-Control')).toContain('no-store')
})
