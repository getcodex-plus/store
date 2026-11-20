import { expect, test, type Page } from '@playwright/test'
import { openAdminPage } from './admin-helpers'
import { db } from '../src/server/db'
import { jsonInput, settingsData } from '../src/server/data'

async function loginAdmin(page: Page) {
  await page.getByRole('button', { name: '管理员登录' }).click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const code = page.getByText(/本地演示验证码：/)
  await expect(code).toBeVisible()
  await page.getByLabel('登录验证码').fill((await code.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

test('brand settings update the storefront, metadata and enrollment without rebuilding', async ({
  page,
  browser,
}) => {
  const original = settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)
  const visitor = await browser.newContext()
  const brandName = 'North Star 北辰商店'
  try {
    await page.goto('/admin')
    await loginAdmin(page)
    await openAdminPage(page, '网站设置')
    await page.getByLabel('网站名称', { exact: true }).fill(brandName)
    await page.locator('input[type=file]').setInputFiles('public/apple-touch-icon.png')
    await expect(page.getByAltText('Logo 预览')).toBeVisible()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByText(`${brandName} 控制台`, { exact: true }).first()).toBeVisible()
    const registration = await page.request.get('/api/auth/passkey/generate-register-options')
    expect(await registration.json()).toMatchObject({ rp: { name: brandName } })
    const shop = await visitor.newPage()
    await shop.goto('/')
    await expect(shop).toHaveTitle(new RegExp(brandName))
    await expect(shop.locator('meta[property="og:site_name"]')).toHaveAttribute(
      'content',
      brandName,
    )
    const jsonLd = await shop.locator('script[type="application/ld+json"]').first().textContent()
    expect(JSON.parse(jsonLd!)).toMatchObject({ '@type': 'WebSite', name: brandName })
    const wordmark = shop.getByRole('link', { name: `${brandName} 首页`, exact: true })
    await expect(wordmark).toHaveCount(2)
    const logoUrl = await wordmark.first().locator('img').getAttribute('src')
    expect(logoUrl).toMatch(/^\/brand-logo\?v=/)
    await expect(shop.locator('link[rel="icon"]')).toHaveAttribute('href', logoUrl!)
    expect((await shop.request.get(logoUrl!)).headers()['content-type']).toBe('image/png')
    const card = await shop.request.get('/opengraph-image')
    expect(card.ok()).toBe(true)
    expect((await card.body()).subarray(1, 4).toString()).toBe('PNG')
    await shop
      .getByRole('button', { name: /登录 \/ 注册/ })
      .first()
      .click()
    await expect(shop.getByRole('dialog')).toContainText(`欢迎来到 ${brandName}`)
    await page.getByRole('button', { name: '恢复默认 Logo' }).click()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByText('已保存', { exact: true }).first()).toBeVisible()
    await expect.poll(async () => (await page.request.get(logoUrl!)).status()).toBe(404)
    await shop.reload()
    await expect(wordmark.first().locator('svg')).toHaveCount(1)
  } finally {
    await visitor.close()
    await db.setting.update({ where: { id: 1 }, data: { body: jsonInput(original) } })
  }
})

test('admin sign-out clears loaded records and unsaved drafts before another session loads', async ({
  page,
}) => {
  await page.goto('/admin')
  await loginAdmin(page)
  await openAdminPage(page, '网站设置')
  await page.getByLabel('支持邮箱', { exact: true }).fill('private-session-draft@example.com')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '管理员登录' })).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/api\/admin(?:\?.*)?$/, async (route) => {
    await gate
    await route.continue()
  })
  try {
    await loginAdmin(page)
    await expect(page.locator('.admin-content .ant-skeleton')).toBeVisible()
    await expect(page.getByLabel('支持邮箱', { exact: true })).toHaveCount(0)
    release()
    await expect(page.locator('.admin-content .ant-skeleton')).toHaveCount(0)
    await openAdminPage(page, '网站设置')
    await expect(page.getByLabel('支持邮箱', { exact: true })).not.toHaveValue(
      'private-session-draft@example.com',
    )
  } finally {
    release()
  }
})

const order = {
  id: 'o_release_payment',
  kind: 'topup',
  productName: '钱包充值',
  email: 'release@example.com',
  contactEmail: 'release@example.com',
  amount: 10000,
  externalAmount: 10000,
  balanceAmount: 0,
  channel: 'alipay',
  createdAt: new Date().toISOString(),
}

test('a stopped redemption tells the buyer to contact support instead of waiting for delivery', async ({
  page,
}) => {
  await page.route('**/api/orders/o_release_payment', (route) =>
    route.fulfill({
      json: {
        ...order,
        kind: 'purchase',
        status: 'processing',
        fulfillmentStatus: 'redemption_conflict',
      },
    }),
  )
  await page.goto('/orders/o_release_payment')
  await expect(page.getByRole('heading', { name: '兑换结果需要人工核对。' })).toBeVisible()
  await expect(page.getByText('请保留原订单并联系支持，不要重复下单或付款。')).toBeVisible()
  await expect(page.getByText('正在充值', { exact: true })).toHaveCount(0)
})

test('slow order responses finish before another background poll starts', async ({ page }) => {
  await page.clock.install()
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/orders/o_release_payment', async (route) => {
    requests++
    await gate
    await route.fulfill({ json: { ...order, status: 'completed' } })
  })
  await page.goto('/orders/o_release_payment')
  try {
    await expect.poll(() => requests).toBe(1)
    await page.clock.fastForward(24000)
    expect(requests).toBe(1)
    release()
    await expect(page.getByText('钱包余额已更新', { exact: true })).toBeVisible()
  } finally {
    release()
  }
})

test('payment already completed refreshes the order immediately instead of showing an empty QR step', async ({
  page,
}) => {
  let paid = false
  await page.route('**/api/orders/o_release_payment', (route) =>
    route.fulfill({ json: { ...order, status: paid ? 'completed' : 'unpaid' } }),
  )
  await page.route('**/api/orders/o_release_payment/pay', (route) => {
    paid = true
    return route.fulfill({ json: { paid: true } })
  })
  await page.goto('/orders/o_release_payment')
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await expect(page.getByText('钱包余额已更新', { exact: true })).toBeVisible()
  await expect(page.getByText('使用对应支付方式扫描二维码')).toHaveCount(0)
})

test('a late polling response cannot restore an unpaid order after payment confirmation', async ({
  page,
}) => {
  await page.clock.install()
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/orders/o_release_payment', async (route) => {
    requests++
    const status = requests >= 3 ? 'completed' : 'unpaid'
    if (requests === 2) await gate
    await route.fulfill({ json: { ...order, status } })
  })
  await page.route('**/api/orders/o_release_payment/pay', (route) =>
    route.fulfill({ json: { paymentUrl: 'https://pay.example.com/synthetic-checkout' } }),
  )
  await page.goto('/orders/o_release_payment')
  await page.getByRole('button', { name: '获取支付信息' }).click()
  try {
    await page.clock.fastForward(8000)
    await expect.poll(() => requests).toBe(2)
    await page.getByRole('button', { name: '刷新付款状态' }).click()
    await expect(page.getByText('钱包余额已更新', { exact: true })).toBeVisible()
    const stale = page.waitForResponse('**/api/orders/o_release_payment')
    release()
    await stale
    await expect(page.getByRole('button', { name: '获取支付信息' })).toHaveCount(0)
    await expect(page.getByText('钱包余额已更新', { exact: true })).toBeVisible()
  } finally {
    release()
  }
})
