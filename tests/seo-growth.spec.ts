import { test, expect } from '@playwright/test'

test('public discovery pages contain readable content, crawlable tier links and distinct metadata', async ({
  request,
  page,
}) => {
  for (const path of ['/compare', '/upgrade', '/help/payment', '/plans/plus', '/guide']) {
    const response = await request.get(path)
    expect(response.status()).toBe(200)
    const html = await response.text()
    expect(html).toContain(`rel="canonical" href="http://localhost:3000${path}"`)
    expect(html).toContain('property="og:title"')
  }
  const html = await (await request.get('/compare')).text()
  for (const id of ['plus', 'pro100', 'pro200', 'pro500'])
    expect(html).toContain(`href="/plans/${id}"`)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/compare')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  const og = await request.get('/opengraph-image')
  expect(og.status()).toBe(200)
  expect(og.headers()['content-type']).toContain('image/png')
})

test('analytics rejects forged payment events and sensitive extra fields', async ({ request }) => {
  const headers = { 'X-GetGPT-Request': '1', Origin: 'http://localhost:3000' }
  for (const data of [
    { event: 'payment_succeeded', productId: 'plus', source: 'direct' },
    { event: 'plan_view', productId: 'plus', source: 'direct', session: 'must-not-store' },
  ]) {
    expect((await request.post('/api/events', { headers, data })).status()).toBe(400)
  }
  expect(
    (
      await request.post('/api/events', {
        headers,
        data: { event: 'plan_view', productId: 'plus', source: 'direct' },
      })
    ).status(),
  ).toBe(200)
})
