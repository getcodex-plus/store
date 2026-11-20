import { openAdminPage } from './admin-helpers'
import { test, expect, type Page } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import { demoSession } from '../src/lib'
import { opaqueLogin } from './opaque-helpers'
const testOrigin = process.env.E2E_BASE_URL || 'http://localhost:3000'
const testEmail = () => `test-${Date.now()}@example.com`
async function login(page: Page, email: string) {
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const alert = page.getByText(/本地演示验证码：/)
  await expect(alert).toBeVisible()
  const code = (await alert.textContent())!.match(/\d{6}/)![0]
  await page.getByPlaceholder('6 位验证码', { exact: true }).fill(code)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
}
test('demo checkout shares the real session form, consent and validation without sending real tokens', async ({
  page,
}) => {
  await page.goto('/checkout?product=plus')
  const sessionInput = page.getByLabel('账号会话信息', { exact: true })
  const verify = page.getByRole('button', { name: /验证账号并确认价格/ })
  await expect(sessionInput).toHaveValue(demoSession())
  await expect(page.getByText('如何准备账号信息？')).toBeVisible()
  await expect(page.getByText('使用测试邮箱体验流程')).toHaveCount(0)
  await expect(verify).toBeDisabled()
  await expect(page.getByLabel('联系邮箱', { exact: true })).toHaveValue('')
  await page.getByLabel('联系邮箱', { exact: true }).fill('contact@example.com')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  let quoteRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/quotes') quoteRequests++
  })
  await sessionInput.fill('invalid json')
  await verify.click()
  await expect(page.getByText('这段信息不是完整的 JSON，请重新复制全部内容')).toBeVisible()
  const realLooking = JSON.stringify({
    user: { email: 'buyer@example.com' },
    accessToken: 'not-a-real-token',
    sessionToken: 'not-a-real-token',
  })
  await sessionInput.fill(realLooking)
  await verify.click()
  await expect(page.getByText('演示环境请使用示例 Session，不要填写真实登录凭证')).toBeVisible()
  expect(quoteRequests).toBe(0)
  const rejected = await page.request.post('/api/quotes', {
    headers: { 'X-GetGPT-Request': '1', Origin: testOrigin },
    data: { productId: 'plus', session: realLooking },
  })
  expect(rejected.status()).toBe(400)
  const email = testEmail()
  await sessionInput.evaluate((element, value) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', value)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    )
  }, demoSession(email))
  await expect(page.locator('.session-preview')).toContainText(email)
  await expect(page.locator('.session-preview')).toContainText('尚未验证')
  await expect(page.locator('.session-preview')).toBeFocused()
  await expect(sessionInput).toHaveCount(0)
  expect(quoteRequests).toBe(0)
  await page.getByRole('button', { name: '编辑账号信息' }).click()
  await expect(sessionInput).toHaveValue(demoSession(email))
  await expect(sessionInput).toBeFocused()
  await page.getByRole('button', { name: '收起账号信息' }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/checkout-account-mobile.png', fullPage: true })
  const submitted = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/quotes',
  )
  await verify.click()
  expect((await submitted).postDataJSON()).toMatchObject({
    productId: 'plus',
    session: demoSession(email),
  })
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  await expect(sessionInput).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '核对订单，选择支付方式' })).toBeVisible()
  await page.screenshot({ path: 'test-results/checkout-confirm-mobile.png', fullPage: true })
})
test('SSR storefront, responsive layout, wallet topup and balance purchase', async ({
  page,
  request,
}) => {
  const html = await (await request.get('/')).text()
  expect(html).toContain('更省心的 ChatGPT')
  expect(html).toContain('ChatGPT Plus')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /更省心的 ChatGPT.*账号充值。/ })).toBeVisible()
  await expect(page.getByRole('link', { name: '开始充值', exact: true })).toHaveAttribute(
    'href',
    '/checkout?product=plus',
  )
  await expect(page.locator('.entry-price')).toContainText('¥135.00')
  await expect(page.getByRole('link', { name: /已有订阅，想升级/ })).toHaveCount(0)
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 812 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await page.screenshot({ path: 'test-results/storefront-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'test-results/storefront-desktop.png', fullPage: true })
  const email = testEmail()
  await login(page, email)
  await page.goto('/wallet')
  await page
    .getByRole('button', { name: /充值余额/ })
    .first()
    .click()
  await page.getByRole('spinbutton').fill('300')
  await page.getByRole('button', { name: '创建充值订单' }).click()
  await expect(page).toHaveURL(/\/orders\/o_/)
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await page.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(page.getByRole('heading', { name: '充值余额已到账。' })).toBeVisible()
  await page.goto('/checkout?product=plus')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByRole('checkbox', { name: /使用账户余额抵扣/ })).not.toBeChecked()
  await page.getByRole('checkbox', { name: /使用账户余额抵扣/ }).check()
  await page.getByRole('button', { name: /确认订单/ }).click()
  await expect(page.getByRole('heading', { name: '已收到付款，正在为你充值。' })).toBeVisible()
  await page.goto('/wallet')
  await expect(page.locator('.wallet-number')).toHaveText('¥165.00')
  await page.goto('/admin')
  await expect(page.getByText('无权访问管理后台')).toBeVisible()
})
test('all recharge tiers and partial wallet payment are visible to buyers', async ({ page }) => {
  await page.goto('/')
  for (const name of ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  }
  const pro = page
    .locator('.plan-card')
    .filter({ has: page.getByRole('heading', { name: 'ChatGPT Pro', exact: true }) })
  await expect(page.locator('.plan-card')).toHaveCount(3)
  for (const [tier, product, price] of [
    ['100', 'pro100', '¥678.00'],
    ['200', 'pro200', '¥1,210.00'],
    ['500', 'pro500', '¥3,260.00'],
  ]) {
    await pro.getByTitle(`ChatGPT Pro ${tier}`, { exact: true }).click()
    await expect(pro.getByRole('radio', { name: `Pro ${tier}`, exact: true })).toBeChecked()
    await expect(pro.locator('.price')).toContainText(price)
    await expect(pro.locator('.plan-official-price')).toHaveCount(0)
    await expect(pro.locator('.plan-price-saving')).toHaveCount(0)
    await expect(pro.getByRole('link', { name: '选择此套餐' })).toHaveAttribute(
      'href',
      `/checkout?product=${product}`,
    )
    await expect(pro.getByRole('link', { name: /了解套餐详情/ })).toHaveAttribute(
      'href',
      `/plans/${product}`,
    )
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await pro.getByTitle('ChatGPT Pro 200', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/pro-card-mobile.png', fullPage: true })
  await pro.getByRole('link', { name: '选择此套餐' }).click()
  await expect(page).toHaveURL(/product=pro200/)
  await expect(page.locator('.order-summary h2')).toHaveText('ChatGPT Pro 200')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await login(page, testEmail())
  await page.goto('/wallet')
  await page
    .getByRole('button', { name: /充值余额/ })
    .first()
    .click()
  await page.getByRole('spinbutton').fill('30')
  await page.getByRole('button', { name: '创建充值订单' }).click()
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await page.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(page.getByRole('heading', { name: '充值余额已到账。' })).toBeVisible()
  await page.goto('/checkout?product=plus')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByRole('checkbox', { name: /使用账户余额抵扣/ })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: /账户余额/ })).toHaveCount(0)
  await page.getByRole('checkbox', { name: /使用账户余额抵扣/ }).check()
  await expect(page.getByLabel('本次余额抵扣')).toHaveValue('30.00')
  await expect(page.locator('.checkout-total')).toContainText('¥105.00')
  await page.getByRole('checkbox', { name: /使用账户余额抵扣/ }).uncheck()
  await expect(page.locator('.checkout-total')).toContainText('¥135.00')
  await page.getByRole('checkbox', { name: /使用账户余额抵扣/ }).check()
  await page.getByRole('button', { name: /确认订单/ }).click()
  await expect(page.getByRole('heading', { name: '应付 ¥105.00' })).toBeVisible()
  await page.screenshot({ path: 'test-results/split-payment-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await page.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(page.getByRole('heading', { name: '充值完成，开始使用吧。' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('link', { name: /查看我的升级报价/ })).toHaveCount(0)
  const publicData = await (await page.request.get('/api/bootstrap')).json()
  expect(publicData.settings.upgradePricing).toBeUndefined()
  expect(publicData.products.every((product: { upgrade: boolean }) => !product.upgrade)).toBe(true)
})
test('guest referral is credited before signup and channel limits save and reject invalid orders', async ({
  browser,
  page,
}) => {
  await page.goto('/')
  await login(page, testEmail())
  const referrer = await (await page.request.get('/api/bootstrap')).json()
  const deniedEstimate = await page.request.post('/api/admin/withdrawals/estimate', {
    headers: { 'X-GetGPT-Request': '1', Origin: testOrigin },
    data: { id: 'not-visible-to-customers' },
  })
  expect(deniedEstimate.status()).toBe(403)
  const guest = await browser.newContext()
  try {
    const guestPage = await guest.newPage()
    await guestPage.goto(`/?ref=${referrer.user.referralCode}`)
    await guestPage
      .getByRole('link', { name: /选择此套餐/ })
      .first()
      .click()
    await guestPage
      .getByLabel('账号会话信息', { exact: true })
      .fill(demoSession(`recharge-${testEmail()}`))
    await guestPage.getByLabel('联系邮箱', { exact: true }).fill(testEmail())
    await guestPage.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
    await guestPage.getByRole('button', { name: /验证账号并确认价格/ }).click()
    await guestPage.getByLabel('联系邮箱', { exact: true }).fill(testEmail())
    await guestPage.getByRole('button', { name: /确认订单/ }).click()
    await guestPage.getByRole('button', { name: '获取支付信息' }).click()
    await guestPage.getByRole('button', { name: '模拟付款成功' }).click()
    await expect(guestPage.getByRole('heading', { name: '充值完成，开始使用吧。' })).toBeVisible()
    const account = await (await page.request.get('/api/account')).json()
    expect(account.commissions).toHaveLength(1)
    expect(account.commissions[0].amount).toBeGreaterThan(0)
  } finally {
    await guest.close()
  }
  const admin = await browser.newContext()
  try {
    const adminPage = await admin.newPage()
    await adminPage.goto('/')
    await login(adminPage, 'admin@example.com')
    const previous = await (await adminPage.request.get('/api/admin')).json()
    try {
      await adminPage.goto('/admin')
      await openAdminPage(adminPage, '网站设置')
      await adminPage.getByLabel('支付宝最低金额（元）').fill('2')
      await adminPage.getByLabel('支付宝最高金额（元）').fill('50')
      const destinations = [
        ['alipay', '支付宝'],
        ['wechat', '微信'],
        ['ERC20', 'Ethereum'],
        ['TRC20', 'Tron'],
        ['BSC', 'BNB Smart Chain'],
        ['Polygon', 'Polygon'],
      ]
      for (const [index, [, label]] of destinations.entries()) {
        await adminPage
          .getByLabel(`${label}最低起提（元）`, { exact: true })
          .fill((11.11 + index).toFixed(2))
        await adminPage
          .getByLabel(`${label}手续费（%）`, { exact: true })
          .fill((1.25 + index).toFixed(2))
        await adminPage
          .getByLabel(`${label}固定手续费（元）`, { exact: true })
          .fill((0.5 + index).toFixed(2))
      }
      await adminPage.getByRole('switch', { name: '支付宝提现', exact: true }).uncheck()
      await adminPage.getByRole('switch', { name: 'USDT提现', exact: true }).check()
      await adminPage.getByRole('switch', { name: 'BNB Smart Chain提现', exact: true }).check()
      await adminPage.getByRole('switch', { name: 'Ethereum提现', exact: true }).uncheck()
      await adminPage.getByRole('button', { name: '保存设置', exact: true }).click()
      await expect(adminPage.getByText('已保存', { exact: true }).first()).toBeVisible()
      const savedSettings = (await (await adminPage.request.get('/api/bootstrap')).json()).settings
      expect(savedSettings.alipay).toBe(previous.settings.alipay)
      expect(savedSettings.withdrawalChannels.alipay).toBe(false)
      expect(savedSettings.withdrawalChannels.networks.ERC20).toBe(false)
      expect(savedSettings.withdrawalChannels.networks.BSC).toBe(true)
      for (const [index, [key]] of destinations.entries()) {
        expect(savedSettings.withdrawalChannels.rules[key]).toEqual({
          minimum: 1111 + index * 100,
          feeRateBps: 125 + index * 100,
          fixedFee: 50 + index * 100,
        })
      }
      const response = await page.request.post('/api/orders', {
        headers: { 'X-GetGPT-Request': '1', Origin: testOrigin },
        data: { amount: 100, channel: 'alipay', requestKey: crypto.randomUUID() },
      })
      expect(response.status()).toBe(409)
    } finally {
      const restored = await adminPage.request.post('/api/admin/settings', {
        headers: { 'X-GetGPT-Request': '1', Origin: testOrigin },
        data: previous.settings,
      })
      expect(restored.ok()).toBe(true)
    }
  } finally {
    await admin.close()
  }
})
test('admin sets fixed base prices and cached currency conversion but cannot sell upgrades', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'admin@example.com')
  const original = await (await page.request.get('/api/admin')).json()
  const product = original.products.find((p: { id: string }) => p.id === 'go')
  const headers = { 'X-GetGPT-Request': '1', Origin: testOrigin }
  try {
    await page.goto('/admin')
    await openAdminPage(page, '商品管理')
    const row = page.getByRole('row').filter({ hasText: 'ChatGPT Go' })
    await row.getByRole('button', { name: '编辑商品' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('定价方式')).toHaveCount(0)
    await expect(dialog.getByLabel('成本加价（%）')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '请求刷新价格' })).toHaveCount(0)
    await dialog.getByLabel('固定售价（元）').fill('49.37')
    await dialog.getByRole('button', { name: '保存商品' }).click()
    await expect(dialog).toBeHidden()
    const fixed = await (
      await page.request.post('/api/quotes', {
        headers,
        data: { productId: 'go', session: demoSession('rounding@example.com') },
      })
    ).json()
    expect(fixed.amount).toBe(4937)
    const catalog = await (await page.request.get('/api/bootstrap')).json()
    const publicProduct = catalog.products.find((p: { id: string }) => p.id === 'go')
    expect(publicProduct.price).toBe(4937)
    expect(publicProduct.pricingMode).toBe('fixed')
    expect(publicProduct.pricing).toBeUndefined()
    expect(await (await page.request.get('/')).text()).toContain('¥49.37')
    expect(await (await page.request.get('/plans/go')).text()).toContain('¥49.37')
    const invalidDynamic = await page.request.post('/api/admin/products', {
      headers,
      data: { ...product, pricingMode: 'markup' },
    })
    expect(invalidDynamic.status()).toBe(400)

    const fx = (await (await page.request.get('/api/admin')).json()).exchangeRate
    expect(fx.available).toBe(true)
    await row.getByRole('button', { name: '编辑商品' }).click()
    await dialog.getByLabel('基础售价币种').click()
    await page.getByText('美元（自动换算人民币）', { exact: true }).last().click()
    await dialog.getByLabel('固定售价（美元）').fill('20')
    await dialog.getByLabel('人民币售价取整').click()
    await page.getByText('向上取整到元', { exact: true }).last().click()
    await dialog.getByRole('button', { name: '保存商品' }).click()
    await expect(dialog).toBeHidden()
    const converted = Math.ceil(20 * fx.rate) * 100
    const usdQuote = await (
      await page.request.post('/api/quotes', {
        headers,
        data: { productId: 'go', session: demoSession('rounding@example.com') },
      })
    ).json()
    expect(usdQuote.amount).toBe(converted)
    const usdCatalog = await (await page.request.get('/api/bootstrap')).json()
    expect(usdCatalog.products.find((p: { id: string }) => p.id === 'go').price).toBe(converted)
    // Converted product prices remain visible without an official-price comparison.
    await page.goto('/')
    const expensiveGo = page
      .locator('.plan-card')
      .filter({ has: page.getByRole('heading', { name: 'ChatGPT Go', exact: true }) })
    await expect(expensiveGo.locator('.price')).toContainText((converted / 100).toFixed(2))
    await expect(expensiveGo.locator('.plan-price-comparison')).toHaveCount(0)
    await page.goto('/checkout?product=go')
    await expect(page.locator('.summary-price')).toContainText((converted / 100).toFixed(2))
    await page.goto('/admin')
    await openAdminPage(page, '网站设置')
    await expect(page.getByRole('button', { name: '请求刷新汇率' })).toBeVisible()
    await expect(page.getByLabel('升级汇率来源')).toHaveCount(0)
    const upgrade = await page.request.post('/api/quotes', {
      headers,
      data: { productId: 'upgrade-pro500', session: demoSession('rounding@example.com') },
    })
    expect(upgrade.status()).toBe(404)
    const invalidUpgrade = await page.request.post('/api/admin/products', {
      headers,
      data: { ...product, upgrade: true, plan: 'plus', pricingMode: 'fixed' },
    })
    expect(invalidUpgrade.status()).toBe(400)
  } finally {
    expect((await page.request.post('/api/admin/products', { headers, data: product })).ok()).toBe(
      true,
    )
    expect(
      (await page.request.post('/api/admin/settings', { headers, data: original.settings })).ok(),
    ).toBe(true)
  }
})
test('procurement requires an admin, defaults off and never charges a supplier in demo', async ({
  page,
}) => {
  const headers = { origin: testOrigin, 'X-GetGPT-Request': '1' }
  expect((await page.request.get('/api/admin/procurement')).status()).toBe(401)
  expect((await page.request.post('/api/aicdk/webhook', { data: {} })).status()).toBe(404)
  await page.goto('/')
  await login(page, 'admin@example.com')
  await page.goto('/admin')
  await openAdminPage(page, '商品管理')
  await page.getByRole('button', { name: '读取上游目录' }).click()
  await expect(page.getByText('该服务尚未启用，请联系管理员')).toBeVisible()
  const purchase = await page.request.post('/api/admin/procurement/orders', {
    headers,
    data: {
      requestKey: crypto.randomUUID(),
      integrationId: 'absent',
      productId: 'plus',
      upstreamProductId: 1,
      skuId: 2,
      quantity: 1,
    },
  })
  expect(purchase.status()).toBe(409)
  expect((await purchase.json()).error).toContain('演示模式')
  expect((await (await page.request.get('/api/admin/procurement')).json()).purchases).toEqual([])
})
test('saved procurement mappings reopen without a catalog and drafts do not cross plans', async ({
  page,
}) => {
  let mapping = {
    productId: 'plus',
    integrationId: 'supplier',
    upstreamProductId: 20,
    skuId: 34,
    purchaseAfterPayment: true,
  }
  await page.route('**/api/admin/procurement', (route) =>
    route.fulfill({ json: { mappings: [mapping], purchases: [] } }),
  )
  await page.route('**/api/admin/procurement/mapping', (route) => {
    mapping = route.request().postDataJSON()
    return route.fulfill({ json: { saved: true } })
  })
  await page.route('**/api/admin/procurement/catalog?*', (route) => {
    const skuId = new URL(route.request().url()).searchParams.get('page') === '1' ? 35 : 34
    return route.fulfill({
      json: {
        integrationId: 'supplier',
        info: { site_name: '测试目录', balance: '0', currency: 'CNY' },
        total: 51,
        items: [
          {
            id: 20,
            is_active: true,
            fulfillment_type: 'auto',
            title: { 'zh-CN': '测试商品' },
            skus: [
              {
                id: skuId,
                is_active: true,
                sku_code: `S${skuId}`,
                price_amount: '2',
                stock_quantity: 1,
              },
            ],
          },
        ],
      },
    })
  })
  await page.goto('/')
  await login(page, 'admin@example.com')
  await page.goto('/admin')
  await openAdminPage(page, '商品管理')
  const savedPlan = page.getByRole('button', { name: 'ChatGPT Plus', exact: true })
  const row = page.getByRole('row').filter({ has: savedPlan })
  const mode = page.getByRole('checkbox', { name: /付款后按单采购/ })
  const save = page.getByRole('button', { name: '保存映射' })
  const dropdown = page.locator('.ant-select-dropdown:visible')
  await expect(row).toContainText('付款后按单采购')
  await expect(page.getByText('暂无采购记录')).toBeVisible()
  await savedPlan.click()
  await expect(page.getByText('SKU #34（已保存）', { exact: true })).toBeVisible()
  await expect(mode).toBeChecked()
  await page.getByRole('button', { name: '读取上游目录' }).click()
  await expect(save).toBeDisabled()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText(/测试商品 · S34/)).toBeVisible()
  await expect(mode).toBeChecked()
  await page.getByRole('button', { name: '上一页' }).click()
  await page.getByLabel('上游 SKU').click()
  await dropdown.getByText(/测试商品 · S35/).click()
  await expect(mode).not.toBeChecked()
  await page.getByLabel('本地充值套餐').click()
  await dropdown.getByText('ChatGPT Go', { exact: true }).click()
  await expect(page.getByText('选择上游发卡 SKU', { exact: true })).toBeVisible()
  await expect(save).toBeDisabled()
  await savedPlan.click()
  await expect(mode).toBeChecked()
  await page.getByLabel('上游 SKU').click()
  await dropdown.getByText(/测试商品 · S35/).click()
  await save.click()
  await expect(row).toContainText('手动进货')
  expect(mapping).toEqual({
    productId: 'plus',
    integrationId: 'supplier',
    upstreamProductId: 20,
    skuId: 35,
    purchaseAfterPayment: false,
  })
  await page.reload()
  await openAdminPage(page, '商品管理')
  await expect(row.getByRole('cell', { name: '35', exact: true })).toBeVisible()
  await savedPlan.click()
  await expect(page.getByText('SKU #35（已保存）', { exact: true })).toBeVisible()
  await expect(mode).not.toBeChecked()
})
test('EPay has one entry and selects protocol-specific fields inside configuration', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'admin@example.com')
  await page.goto('/admin')
  await openAdminPage(page, '支付与服务')
  await expect(page.getByRole('heading', { name: '易支付', exact: true })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: /易支付 v[12]/ })).toHaveCount(0)
  const card = page
    .locator('.ant-card')
    .filter({ has: page.getByRole('heading', { name: '易支付', exact: true }) })
  await card.getByRole('button').click()
  const dialog = page.getByRole('dialog', { name: '配置 易支付' })
  await dialog.getByLabel('协议版本').click()
  await page.getByText('v1（MD5）', { exact: true }).last().click()
  await expect(dialog.getByLabel('商户密钥（MD5）')).toBeVisible()
  await expect(dialog.getByLabel('商户私钥（PEM）')).toHaveCount(0)
  await dialog.getByLabel('商户密钥（MD5）').fill('unsaved-test-value')
  await dialog.getByLabel('协议版本').click()
  await page.getByText('v2（RSA-SHA256）', { exact: true }).last().click()
  await expect(dialog.getByLabel('商户密钥（MD5）')).toHaveCount(0)
  await expect(dialog.getByLabel('商户私钥（PEM）')).toBeVisible()
  await expect(dialog.getByLabel('平台公钥（PEM）')).toBeVisible()
  await expect(dialog.getByLabel('商户私钥（PEM）')).toHaveValue('')
  await dialog.getByLabel('协议版本').click()
  await page.getByText('v1（MD5）', { exact: true }).last().click()
  await expect(dialog.getByLabel('商户密钥（MD5）')).toHaveValue('')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await openAdminPage(page, '网站设置')
  await page.getByLabel('支付宝 / 微信默认渠道').click()
  const options = page.locator('.ant-select-dropdown:visible')
  await expect(options.getByText('易支付', { exact: true })).toBeVisible()
  await expect(options.getByText(/易支付 v[12]/)).toHaveCount(0)
  const previous = (await (await page.request.get('/api/admin')).json()).settings
  try {
    await options.getByText('易支付', { exact: true }).click()
    await expect(page.getByRole('button', { name: /保存设置/ })).not.toHaveClass(/ant-btn-loading/)
    await page.getByRole('button', { name: /保存设置/ }).click()
    await expect
      .poll(async () => (await (await page.request.get('/api/admin')).json()).settings.fiatProvider)
      .toBe(previous.epayVersion)
  } finally {
    expect(
      (
        await page.request.post('/api/admin/settings', {
          headers: { 'X-GetGPT-Request': '1', Origin: testOrigin },
          data: previous,
        })
      ).ok(),
    ).toBe(true)
  }
})
test('admin configuration keeps secrets write-only and uses separate RBAC roles', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'admin@example.com')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible()
  await page.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true })
  await openAdminPage(page, '支付与服务')
  const card = page
    .locator('.ant-card')
    .filter({ has: page.getByRole('heading', { name: 'AICDK 兑换服务' }) })
  await card.getByRole('button').click()
  const dialog = page.getByRole('dialog')
  const address = dialog.getByLabel('AICDK 地址')
  await expect(address).toHaveValue('https://cdki.link')
  await address.fill('http://aicdk.internal:8080')
  await dialog.getByLabel('开放 API Key').fill('test-only-write-only-key')
  await dialog.getByRole('switch').check()
  await dialog.getByRole('button', { name: '加密保存配置' }).click()
  await expect(dialog).toBeHidden()
  await card.getByRole('button').click()
  await expect(page.getByLabel('开放 API Key')).toHaveValue('')
  await expect(address).toHaveValue('http://aicdk.internal:8080')
  await expect(page.getByLabel('开放 API Key')).toHaveAttribute(
    'placeholder',
    '已保存，留空保持不变',
  )
  await page.getByRole('dialog').locator('.ant-modal-close').click()
  await openAdminPage(page, '角色与权限')
  await expect(page.getByRole('heading', { name: '角色与权限' })).toBeVisible()
  await expect(page.getByText('客服', { exact: true }).first()).toBeVisible()
  const adminData = await (await page.request.get('/api/admin')).json()
  expect(
    adminData.users.find((user: { email: string }) => user.email === 'admin@example.com').role,
  ).toBe('admin')
  await openAdminPage(page, '风控记录')
  await expect(page.getByRole('heading', { name: '风控记录' })).toBeVisible()
  await expect(page.getByText('风控决策记录', { exact: true })).toBeVisible()
  expect(Array.isArray(adminData.riskEvents)).toBe(true)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: 'test-results/admin-mobile.png', fullPage: true })
})
test('two-step verification defaults off and enables email without a Passkey', async ({ page }) => {
  await page.goto('/')
  await login(page, testEmail())
  await page.goto('/security')
  const toggle = page.getByRole('switch', { name: '二步验证', exact: true })
  await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('button', { name: '设置 TOTP' })).toHaveCount(0)
  await toggle.click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /继\s*续/ })
    .click()
  await expect(toggle).toBeChecked()
  await expect(page.getByText('固定开启', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '设置 TOTP' })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect((await (await page.request.get('/api/security')).json()).totp).toBe(false)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/security-two-step-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'test-results/security-two-step-desktop.png', fullPage: true })
  await toggle.click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭二步验证', exact: true }).click()
  await expect(toggle).not.toBeChecked()
})
test('Passkey requires email or TOTP after password and deleting it preserves TOTP without recovery codes', async ({
  page,
  context,
}) => {
  const password = `test-${crypto.randomUUID()}-long-password`
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto('/')
  const email = testEmail()
  await login(page, email)
  await page.goto('/security')
  await page.getByLabel('新密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByText('密码已更新，其他登录会话已注销')).toBeVisible()
  await page.getByRole('button', { name: '添加 Passkey' }).click()
  await expect(page.getByText('Passkey 已添加，密码登录将需要二步验证')).toBeVisible()
  const headers = { Origin: testOrigin, 'X-GetGPT-Request': '1' }
  await expect(page.getByRole('switch', { name: '二步验证', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: '二步验证', exact: true })).toBeDisabled()
  expect(
    (
      await page.request.post('/api/auth/two-factor/disable', {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(403)
  async function passwordChallenge() {
    await page.request.post('/api/auth/sign-out', { headers, data: {} })
    const result = await opaqueLogin(page.request, email, password, headers)
    expect(result.ok()).toBe(true)
    expect((await page.request.get('/api/account')).status()).toBe(401)
    return result.json()
  }
  async function verifyEmailFactor() {
    expect(
      (await page.request.post('/api/auth/two-factor/send-otp', { headers, data: {} })).ok(),
    ).toBe(true)
    const { demoCode } = await (
      await page.request.post('/api/demo/code', { headers, data: { email } })
    ).json()
    const result = await page.request.post('/api/auth/two-factor/verify-otp', {
      headers,
      data: { code: demoCode },
    })
    expect(result.ok()).toBe(true)
    expect((await page.request.get('/api/account')).status()).toBe(200)
  }
  const emailOnly = await passwordChallenge()
  expect(emailOnly.twoFactorRedirect).toBe(true)
  expect(emailOnly.twoFactorMethods).toEqual(['otp'])
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-otp', {
        headers,
        data: { code: 'invalid' },
      })
    ).ok(),
  ).toBe(false)
  expect((await page.request.get('/api/account')).status()).toBe(401)
  await verifyEmailFactor()
  await page.request.post('/api/auth/sign-out', { headers, data: {} })
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByRole('tab', { name: '密码登录' }).click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  // Email-only MFA sends automatically; no separate send action is required.
  await expect(page.getByLabel('TOTP 动态验证码')).toHaveCount(0)
  const emailOnlyAlert = page.getByText(/本地演示二步验证码：/)
  await expect(emailOnlyAlert).toBeVisible()
  await page
    .getByLabel('邮箱二步验证码')
    .fill((await emailOnlyAlert.textContent())!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: '完成二步验证', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.goto('/security')
  await page.getByRole('button', { name: '设置 TOTP', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /继\s*续/ })
    .click()
  const setup = page.getByRole('dialog')
  await setup.getByText('无法扫码？查看手动密钥').click()
  const secret = await setup.locator('code').textContent()
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret!),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  })
  await setup.getByPlaceholder('6 位动态验证码').fill(totp.generate())
  await setup.getByRole('button', { name: '验证并启用' }).click()
  await expect(page.getByText('TOTP 已启用', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新生成恢复码' })).toHaveCount(0)
  for (const path of ['verify-backup-code', 'generate-backup-codes']) {
    expect(
      (
        await page.request.post(`/api/auth/two-factor/${path}`, {
          headers,
          data: { code: 'old-code', password },
        })
      ).status(),
    ).toBe(404)
  }
  const challenge = await passwordChallenge()
  expect(challenge.twoFactorMethods).toEqual(['totp', 'otp'])
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-totp', {
        headers,
        data: { code: totp.generate(), trustDevice: true },
      })
    ).status(),
  ).toBe(400)
  expect((await page.request.get('/api/account')).status()).toBe(401)
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-totp', {
        headers,
        data: { code: totp.generate() },
      })
    ).ok(),
  ).toBe(true)
  await passwordChallenge()
  await verifyEmailFactor()
  const enrolled = await (await page.request.get('/api/security')).json()
  expect(enrolled).not.toHaveProperty('recoveryRemaining')
  expect(
    (
      await page.request.post('/api/auth/passkey/delete-passkey', {
        headers,
        data: { id: enrolled.passkeys[0].id },
      })
    ).ok(),
  ).toBe(true)
  expect((await page.request.get('/api/account')).status()).toBe(401)
  const afterRemoval = await passwordChallenge()
  expect(afterRemoval.twoFactorMethods).toEqual(['totp', 'otp'])
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-totp', {
        headers,
        data: { code: totp.generate() },
      })
    ).ok(),
  ).toBe(true)
  const preserved = await (await page.request.get('/api/security')).json()
  expect(preserved.totp).toBe(true)
  expect(preserved.passkeys).toHaveLength(0)
  await page.request.post('/api/auth/sign-out', { headers, data: {} })
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByRole('tab', { name: '密码登录' }).click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByLabel('TOTP 动态验证码')).toBeVisible()
  await page.getByRole('tab', { name: '邮箱验证码' }).click()
  await page.getByRole('button', { name: '发送邮箱验证码' }).click()
  const alert = page.getByText(/本地演示二步验证码：/)
  await expect(alert).toBeVisible()
  await page.getByLabel('邮箱二步验证码').fill((await alert.textContent())!.match(/\d{6}/)![0])
  await page.getByRole('button', { name: '完成二步验证', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
})
test('rejects cross-origin mutations and unauthenticated admin reads', async ({ request }) => {
  const csrf = await request.post('/api/auth/email-otp/send-verification-otp', {
    headers: { Origin: 'https://attacker.invalid', 'X-GetGPT-Request': '1' },
    data: { email: 'test@example.com', type: 'sign-in' },
  })
  expect(csrf.status()).toBe(403)
  expect((await request.get('/api/admin')).status()).toBe(401)
  const callback = await request.post('/api/payments/notify/epay_v1/missing', {
    data: 'pid=1&sign=invalid',
  })
  expect(callback.status()).not.toBe(200)
})

test('guest checkout requires contact email and only verified owner can claim orders', async ({
  page,
  browser,
}) => {
  const email = testEmail()
  await page.goto('/checkout?product=plus')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByText('请填写有效的联系邮箱，用于接收订单通知')).toBeVisible()
  await expect(page.getByLabel('联系邮箱', { exact: true })).toHaveValue('')
  await page.getByLabel('联系邮箱', { exact: true }).fill(email)
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByText('demo@example.com', { exact: true })).toBeVisible()
  await expect(page.getByLabel('联系邮箱', { exact: true })).toHaveValue(email)
  await page.getByLabel('联系邮箱', { exact: true }).fill('')
  await page.getByRole('button', { name: /确认订单/ }).click()
  await expect(page.getByText('请填写有效的联系邮箱，用于接收订单通知')).toBeVisible()
  await page.getByLabel('联系邮箱', { exact: true }).fill(email)
  await page.getByRole('button', { name: /确认订单/ }).click()
  await expect(page).toHaveURL(/\/orders\/o_/)
  const orderPath = new URL(page.url()).pathname
  await expect(page.getByText(`订单联系邮箱：${email}`)).toBeVisible()
  const stranger = await browser.newContext({ baseURL: testOrigin })
  expect((await stranger.request.get(`/api${orderPath}`)).status()).toBe(404)
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await page.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(page.getByRole('heading', { name: '充值完成，开始使用吧。' })).toBeVisible()
  const otherPage = await stranger.newPage()
  await otherPage.goto('/')
  await login(otherPage, email)
  await otherPage.goto(orderPath)
  await expect(otherPage.getByRole('heading', { name: '充值完成，开始使用吧。' })).toBeVisible()
  const claimed = await otherPage.request.get(`/api${orderPath}`)
  expect((await claimed.json()).userId).toBeTruthy()
  // A claimed order requires its account; the old anonymous browser capability is revoked.
  expect((await page.request.get(`/api${orderPath}`)).status()).toBe(404)
  await stranger.close()
})

test('optional Turnstile gates email and purchase requests but exempts Passkey login', async ({
  page,
  request,
  context,
}) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto('/')
  await login(page, 'admin@example.com')
  await page.goto('/security')
  await page.getByRole('button', { name: '添加 Passkey' }).click()
  await expect(page.getByText('Passkey 已添加，密码登录将需要二步验证')).toBeVisible()
  const headers = { Origin: testOrigin, 'X-GetGPT-Request': '1' }
  const body = {
    provider: 'turnstile',
    enabled: true,
    public: { siteKey: 'test-config-only', login: 'true', purchase: 'true' },
    secrets: { secret: 'test-config-only' },
  }
  const save = await page.request.post('/api/admin/integrations', { headers, data: body })
  expect(save.ok()).toBe(true)
  try {
    for (const endpoint of ['/api/quotes', '/api/orders'])
      expect((await request.post(endpoint, { headers, data: {} })).status()).toBe(403)
    for (const endpoint of [
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/sign-in/email',
      '/api/auth/sign-in/opaque/challenge',
      '/api/auth/sign-in/email-otp',
    ]) {
      const result = await request.post(endpoint, {
        headers,
        data: {
          email: 'test@example.com',
          type: 'sign-in',
          password: 'test-password',
          otp: '123456',
          loginRequest: 'invalid',
          response: {},
        },
      })
      expect(result.status()).toBe(403)
    }
    const bootstrap = await (await request.get('/api/bootstrap')).json()
    expect(bootstrap.turnstile).toEqual({
      siteKey: 'test-config-only',
      login: true,
      purchase: true,
    })
    expect(bootstrap.turnstile.secret).toBeUndefined()
    // A broken/unavailable widget must not prevent a real WebAuthn sign-in.
    await page.route('https://challenges.cloudflare.com/**', (route) => route.abort())
    await page.request.post('/api/auth/sign-out', { headers, data: {} })
    await page.goto('/')
    await page
      .getByRole('button', { name: /登录 \/ 注册/ })
      .first()
      .click()
    const passkeyRequest = page.waitForRequest('**/api/auth/passkey/verify-authentication')
    await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
    expect((await passkeyRequest).headers()['x-turnstile-token']).toBeUndefined()
    await expect(page.getByRole('dialog')).toBeHidden()
    expect((await page.request.get('/api/account')).status()).toBe(200)
  } finally {
    expect(
      (
        await page.request.post('/api/admin/integrations', {
          headers,
          data: { ...body, enabled: false },
        })
      ).ok(),
    ).toBe(true)
  }
})
