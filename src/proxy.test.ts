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

it('allows analytics connections only when a valid measurement ID is configured', () => {
  vi.stubEnv('NODE_ENV', 'production')
  const request = new NextRequest('https://shop.example/checkout')
  for (const id of ['', 'GTM-ABC123', 'G-ABC; https://untrusted.example']) {
    vi.stubEnv('NEXT_PUBLIC_GA_ID', id)
    const policy = proxy(request).headers.get('Content-Security-Policy')!
    expect(policy).not.toContain('google-analytics.com')
    expect(policy).not.toContain('googletagmanager.com')
    expect(policy).not.toContain('untrusted.example')
  }
  vi.stubEnv('NEXT_PUBLIC_GA_ID', 'G-TEST123')
  const policy = proxy(request).headers.get('Content-Security-Policy')!
  expect(policy).toContain('https://*.google-analytics.com')
  expect(policy).toContain('https://*.analytics.google.com')
  expect(policy).toContain('https://www.googletagmanager.com')
  expect(policy).toContain("'strict-dynamic'")
  expect(policy).not.toContain("'unsafe-eval'")
  expect(policy).not.toContain('doubleclick.net')
})

it('allows Tawk resources and secure sockets without relaxing script execution', () => {
  vi.stubEnv('NODE_ENV', 'production')
  const response = proxy(new NextRequest('https://shop.example/checkout'))
  const policy = response.headers.get('Content-Security-Policy')!
  const directives = Object.fromEntries(
    policy.split('; ').map((entry) => {
      const [name, ...sources] = entry.split(' ')
      return [name, sources]
    }),
  )
  expect(directives['script-src']).toContain("'strict-dynamic'")
  expect(directives['script-src']).not.toContain("'unsafe-inline'")
  expect(directives['script-src']).not.toContain("'unsafe-eval'")
  expect(directives['connect-src']).toContain('wss://*.tawk.to')
  expect(directives['connect-src']).not.toContain('wss:')
  expect(directives['connect-src']).not.toContain('*')
  for (const directive of [
    'connect-src',
    'img-src',
    'font-src',
    'style-src',
    'frame-src',
    'media-src',
  ])
    expect(directives[directive]).toContain('https://*.tawk.to')
  expect(directives['img-src']).toContain('https://*.tawk.link')
  expect(directives['script-src-attr']).toEqual(["'none'"])
})
