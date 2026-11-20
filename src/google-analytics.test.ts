import { expect, it } from 'vitest'
import { analyticsPage, analyticsReferrer, googleAnalyticsId } from './google-analytics'

it('requires a GA4 measurement ID, never a GTM container or injected URL', () => {
  expect(googleAnalyticsId(' G-ABC123 ')).toBe('G-ABC123')
  for (const value of [undefined, '', 'GTM-ABC123', 'G-', 'G-ABC?x=1', 'G-ABC"><script>'])
    expect(googleAnalyticsId(value)).toBeUndefined()
})

it('removes query strings, fragments, dynamic identifiers and unknown paths from page data', () => {
  const origin = 'https://shop.example'
  expect(analyticsPage('/checkout', origin, '北辰商店').page_title).toBe('结算 · 北辰商店')
  expect(analyticsPage('/checkout?email=private@example.com#session-token', origin)).toEqual({
    page_location: `${origin}/checkout`,
    page_title: '结算 · GetCodex Plus',
  })
  expect(analyticsPage('/orders/private-order-id', origin).page_location).toBe(
    `${origin}/orders/detail`,
  )
  expect(analyticsPage('/plans/plus', origin).page_location).toBe(`${origin}/plans/detail`)
  for (const path of [
    '/private@example.com',
    '/orders/a/private-token',
    '/constructor',
    '/__proto__',
  ])
    expect(analyticsPage(path, origin)).toEqual({
      page_location: `${origin}/not-found`,
      page_title: '页面未找到 · GetCodex Plus',
    })
  expect(analyticsPage('/guide/', origin).page_location).toBe(`${origin}/guide`)
})

it('retains only an HTTP(S) referrer origin without credentials, path or parameters', () => {
  expect(analyticsReferrer('https://user:pass@search.example/private?q=email#token')).toBe(
    'https://search.example/',
  )
  for (const value of ['', 'not a URL', 'data:text/plain,private', 'javascript:alert(1)'])
    expect(analyticsReferrer(value)).toBe('')
})
