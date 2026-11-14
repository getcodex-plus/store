import { test, expect, type Page } from '@playwright/test'

// Only the browser widget is simulated here. Authentication uses the demo
// backend; server-side Siteverify and receipt enforcement have DB integration tests.
async function mockWidget(page: Page) {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.turnstile = { siteKey: 'mock-widget', login: true, purchase: false }
    await route.fulfill({ response, json: data })
  })
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        let options, container;
        window.turnstile = {
          render(element, config) {
            options = config;
            container = element;
            element.dataset.appearance = config.appearance;
            element.dataset.execution = config.execution;
            return 'mock-widget';
          },
          reset() {},
          remove() { options = null; },
          getResponse() { return ''; },
          isExpired() { return false; }
        };
        window.addEventListener('test-turnstile-success', () => {
          options?.callback('mock-success-token');
        });
        window.addEventListener('test-turnstile-interaction', () => {
          options?.['before-interactive-callback']();
          container.textContent = '模拟人机验证';
          container.style.height = '65px';
        });
        window.addEventListener('test-turnstile-error', () => {
          options?.['error-callback']('mock-error');
        });
        const callback = new URL(document.currentScript.src).searchParams.get('onload');
        window[callback]?.();
      `,
    }),
  )
}

async function openLogin(page: Page) {
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  const widget = page.locator('[data-appearance="interaction-only"]')
  await expect(widget).toHaveAttribute('data-execution', 'render')
  return widget
}

test('prepares Turnstile in the background and waits once across email login', async ({ page }) => {
  await mockWidget(page)
  const widget = await openLogin(page)
  expect((await widget.boundingBox())!.height).toBe(0)
  await page
    .getByPlaceholder('you@example.com')
    .fill(`turnstile-${crypto.randomUUID()}@example.com`)
  const sent: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/email-otp/send-verification-otp'))
      sent.push(request.headers()['x-turnstile-token'] || '')
  })
  await page.getByRole('button', { name: '获取验证码' }).click()
  await expect(page.getByPlaceholder('you@example.com')).toBeDisabled()
  expect(sent).toHaveLength(0)
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-interaction')))
  await expect(page.getByText('模拟人机验证', { exact: true })).toBeVisible()
  const submit = page.getByRole('dialog').getByRole('button', { name: '登录 / 注册' })
  expect((await widget.boundingBox())!.y).toBeLessThan((await submit.boundingBox())!.y)
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-success')))
  const code = page.getByText(/本地演示验证码：/)
  await expect(code).toBeVisible()
  expect(sent).toEqual(['mock-success-token'])
  await expect(widget).toHaveCount(0)
  await page
    .getByPlaceholder('6 位验证码', { exact: true })
    .fill((await code.textContent())!.match(/\d{6}/)![0])
  const request = page.waitForRequest('**/api/auth/sign-in/email-otp')
  await submit.click()
  expect((await request).headers()['x-turnstile-token']).toBe('')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('uses a token that finished before the email button is clicked', async ({ page }) => {
  await mockWidget(page)
  await openLogin(page)
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-success')))
  await page
    .getByPlaceholder('you@example.com')
    .fill(`preverified-${crypto.randomUUID()}@example.com`)
  await page.getByRole('button', { name: '获取验证码' }).click()
  await expect(page.getByText(/本地演示验证码：/)).toBeVisible()
})

test('cancels pending verification when the dialog closes and allows retry after failure', async ({
  page,
}) => {
  await mockWidget(page)
  await openLogin(page)
  let sends = 0
  page.on('request', (request) => {
    if (request.url().includes('/email-otp/send-verification-otp')) sends++
  })
  await page.getByPlaceholder('you@example.com').fill(`cancel-${crypto.randomUUID()}@example.com`)
  await page.getByRole('button', { name: '获取验证码' }).click()
  await expect(page.getByPlaceholder('you@example.com')).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-success')))
  expect(sends).toBe(0)
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await expect(page.locator('[data-execution="render"]')).toHaveCount(1)
  await page.getByPlaceholder('you@example.com').fill(`retry-${crypto.randomUUID()}@example.com`)
  await page.getByRole('button', { name: '获取验证码' }).click()
  await expect(page.getByPlaceholder('you@example.com')).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-error')))
  await expect(page.getByPlaceholder('you@example.com')).toBeEnabled()
  expect(sends).toBe(0)
  await page.getByRole('button', { name: '获取验证码' }).click()
  await expect(page.getByPlaceholder('you@example.com')).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('test-turnstile-success')))
  await expect(page.getByText(/本地演示验证码：/)).toBeVisible()
  expect(sends).toBe(1)
})
