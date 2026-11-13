import { afterEach, expect, it, vi } from 'vitest'
import { serializeJsonLd, siteOrigin } from './seo'
afterEach(() => vi.unstubAllEnvs())
it('requires a real https origin in live mode', () => {
  vi.stubEnv('APP_MODE', 'live')
  vi.stubEnv('APP_URL', 'http://localhost:3000')
  expect(() => siteOrigin()).toThrow()
  vi.stubEnv('APP_URL', 'https://shop.example/path')
  expect(() => siteOrigin()).toThrow()
  vi.stubEnv('APP_URL', 'https://shop.example/')
  expect(siteOrigin()).toBe('https://shop.example')
})
it('prevents product content from closing JSON-LD script tags', () => {
  const content = { name: '</script><script>alert(1)</script>' }
  const encoded = serializeJsonLd(content)
  expect(encoded).not.toContain('<')
  expect(JSON.parse(encoded)).toEqual(content)
})
