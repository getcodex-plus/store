import { expect, test, type Page } from '@playwright/test'
import { googleAnalyticsId } from '../src/google-analytics'

const gaId = googleAnalyticsId(process.env.NEXT_PUBLIC_GA_ID)
const scriptSelector = 'script[src*="googletagmanager.com/gtag/js"]'

async function commands(page: Page) {
  return page.evaluate(() => (window.dataLayer ?? []).map((entry) => Array.from(entry)))
}

async function pageViews(page: Page) {
  return (await commands(page)).filter((entry) => entry[0] === 'event' && entry[1] === 'page_view')
}

test.describe('configured GA4', () => {
  test.skip(!gaId, 'Run with a synthetic NEXT_PUBLIC_GA_ID to test enabled analytics')

  let scriptRequests = 0
  test.beforeEach(async ({ page }) => {
    scriptRequests = 0
    // No Google requests leave this test. Inspect the actual gtag command queue;
    // the small external fixture also proves nonce/CSP permits script execution.
    await page.route('https://www.googletagmanager.com/**', async (route) => {
      scriptRequests++
      await route.fulfill({
        contentType: 'application/javascript',
        body: 'window.__gaScriptLoaded = true',
      })
    })
    await page.route(/https:\/\/[^/]*(?:google-analytics\.com|analytics\.google\.com)\//, (route) =>
      route.abort(),
    )
  })

  test('tracks initial and client-side pages once with sanitized fields and a nonce', async ({
    page,
    baseURL,
  }) => {
    const response = await page.goto('/?email=private%40example.com#session-token')
    const origin = new URL(baseURL!).origin
    await expect.poll(async () => (await pageViews(page)).length).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __gaScriptLoaded?: boolean }).__gaScriptLoaded),
      )
      .toBe(true)
    const nonce = await page
      .locator(scriptSelector)
      .evaluate((element) => (element as HTMLScriptElement).nonce)
    expect(nonce).not.toBe('')
    expect(response?.headers()['content-security-policy']).toContain(`'nonce-${nonce}'`)
    expect(await pageViews(page)).toEqual([
      [
        'event',
        'page_view',
        {
          page_location: `${origin}/`,
          page_title: '首页 · GetCodex Plus',
          page_referrer: '',
          send_to: gaId,
        },
      ],
    ])
    expect((await commands(page)).find((entry) => entry[0] === 'config')).toEqual([
      'config',
      gaId,
      {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      },
    ])

    await page.locator('a[href^="/checkout?product="]').first().click()
    await expect(page.getByLabel('账号会话信息', { exact: true })).toBeVisible()
    await expect.poll(async () => (await pageViews(page)).length).toBe(2)
    expect((await pageViews(page))[1][2]).toEqual({
      page_location: `${origin}/checkout`,
      page_title: '结算 · GetCodex Plus',
      page_referrer: `${origin}/`,
      send_to: gaId,
    })
    await page.getByLabel('账号会话信息', { exact: true }).fill('synthetic-private-session')
    await page.evaluate(() =>
      history.pushState(null, '', `${location.pathname}?email=another-private-value`),
    )
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(/\/\?email=private/)
    await expect.poll(async () => (await pageViews(page)).length).toBe(3)
    const queue = JSON.stringify(await commands(page))
    for (const sensitive of ['private', 'session-token', 'synthetic-private-session', '?', '#'])
      expect(queue).not.toContain(sensitive)
    expect((await commands(page)).filter((entry) => entry[0] === 'config')).toHaveLength(1)
    expect(scriptRequests).toBe(1)
  })

  test('tracks direct checkout and order visits without query parameters or order IDs', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/checkout?product=plus&session=synthetic-secret')
    await expect.poll(async () => (await pageViews(page)).length).toBe(1)
    expect((await pageViews(page))[0][2]).toMatchObject({
      page_location: `${new URL(baseURL!).origin}/checkout`,
    })
    await page.goto('/orders/synthetic-private-order?email=private%40example.com')
    await expect.poll(async () => (await pageViews(page)).length).toBe(1)
    expect((await pageViews(page))[0][2]).toMatchObject({
      page_location: `${new URL(baseURL!).origin}/orders/detail`,
    })
    expect(JSON.stringify(await commands(page))).not.toMatch(/synthetic|private|email=/)
  })

  for (const signal of ['doNotTrack', 'globalPrivacyControl']) {
    test(`does not initialize or request GA when ${signal} is enabled`, async ({ page }) => {
      await page.addInitScript((name) => {
        Object.defineProperty(navigator, name, {
          configurable: true,
          value: name === 'doNotTrack' ? '1' : true,
        })
      }, signal)
      await page.goto('/checkout?product=plus')
      await expect(page.getByLabel('账号会话信息', { exact: true })).toBeVisible()
      // The account picker requires hydration, so this is not merely an SSR check.
      await page.getByLabel('账号会话信息', { exact: true }).fill('synthetic-private-session')
      await expect(page.locator(scriptSelector)).toHaveCount(0)
      expect(await commands(page)).toEqual([])
      expect(scriptRequests).toBe(0)
    })
  }
})
