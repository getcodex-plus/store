import { expect, test, type Page } from '@playwright/test'
import type { Bootstrap, Order } from '../src/types'

async function login(page: Page, email: string) {
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const alert = page.getByText(/本地演示验证码：/)
  await expect(alert).toBeVisible()
  await page.getByLabel('登录验证码').fill((await alert.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

async function verify(page: Page) {
  await page.getByLabel('联系邮箱', { exact: true }).fill('frontend-review@example.com')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByRole('heading', { name: '核对订单，选择支付方式' })).toBeVisible()
}

test('checkout selects an enabled channel and blocks unavailable payments', async ({ page }) => {
  expect((await page.request.get('/api/account/history?kind=orders')).status()).toBe(401)
  const bootstrap = (await (await page.request.get('/api/bootstrap')).json()) as Bootstrap
  let online = true
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        settings: { ...bootstrap.settings, alipay: false, wechat: online, crypto: false },
      },
    }),
  )
  await page.goto('/checkout?product=plus')
  await expect(page.getByRole('link', { name: '打开账号信息操作指引 ↗' })).toBeVisible()
  await verify(page)
  await expect(page.getByRole('radio', { name: /微信/ })).toBeChecked()
  await expect(page.locator('.checkout-total')).toContainText('微信支付待付')
  const created = page.waitForRequest('**/api/orders')
  await page.getByRole('button', { name: /确认订单/ }).click()
  expect((await created).postDataJSON().channel).toBe('wechat')
  await expect(page).toHaveURL(/\/orders\/o_/)
  online = false
  await page.goto('/checkout?product=plus')
  await verify(page)
  await expect(page.getByText('在线支付暂未开放', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /确认订单/ })).toBeDisabled()
  await expect(page.locator('.checkout-total')).toContainText('还需支付')
})

test('checkout locks the submitted account and clears a quote when the product changes', async ({
  page,
}) => {
  await page.goto('/checkout?product=plus')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/quotes', async (route) => {
    await gate
    await route.continue()
  })
  await page.getByLabel('联系邮箱', { exact: true }).fill('frontend-review@example.com')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByLabel('账号会话信息', { exact: true })).toBeDisabled()
  release()
  await expect(page.getByRole('heading', { name: '核对订单，选择支付方式' })).toBeVisible()
  // Next.js integrates native history with useSearchParams. Keep the mounted
  // checkout route so this catches stale quotes across a product-only change.
  await page.evaluate(() => history.pushState(null, '', '/checkout?product=go'))
  await expect(page.locator('.order-summary h2')).toHaveText('ChatGPT Go')
  await expect(page.getByRole('heading', { name: '确认充值账号', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /确认订单/ })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: /我确认有权使用该账号/ })).not.toBeChecked()
})

test('account filters recover and mobile order actions stay reachable', async ({ page }) => {
  await page.goto('/')
  await login(page, `ui-orders-${Date.now()}@example.com`)
  const account = await (await page.request.get('/api/account')).json()
  const order: Order = {
    id: 'o_frontend_review',
    kind: 'purchase',
    userId: null,
    contactEmail: 'contact@example.com',
    email: 'account-with-a-long-email-address@example.com',
    productId: 'plus',
    productName: 'ChatGPT Plus',
    amount: 12900,
    balanceAmount: 0,
    externalAmount: 12900,
    status: 'needs_session',
    channel: 'wechat',
    createdAt: new Date().toISOString(),
    rateBps: 500,
    settlementDays: 7,
    firstOrderOnly: false,
  }
  await page.route('**/api/account', (route) =>
    route.fulfill({ json: { ...account, orders: [order] } }),
  )
  await page.route('**/api/account/history?*', (route) => {
    const params = new URL(route.request().url()).searchParams
    const search = params.get('search') || ''
    const records = [
      order,
      ...Array.from({ length: 8 }, (_, index) => ({
        ...order,
        id: `o_other_${index}`,
        status: 'completed',
        productName: `Earlier plan ${index}`,
      })),
    ]
    const filtered = records.filter(
      (item) =>
        (params.get('status') === 'all' || item.status === 'needs_session') &&
        `${item.id}${item.productName}`.toLowerCase().includes(search.trim().toLowerCase()),
    )
    const current = Number(params.get('page') || 1)
    return route.fulfill({
      json: {
        rows: filtered.slice((current - 1) * 8, current * 8),
        total: filtered.length,
        page: current,
        pageSize: 8,
      },
    })
  })
  await page.goto('/account')
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByLabel('搜索订单号或套餐')).toHaveCSS('font-size', '16px')
  await page.getByRole('tab', { name: '处理中' }).click()
  const update = page.getByRole('link', { name: '更新账号' })
  await expect(update).toBeVisible()
  const box = await update.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  await expect(page.locator('.desktop-orders')).toBeHidden()
  await expect(page.locator('.mobile-orders')).toContainText(order.email)
  await expect(page.locator('.mobile-orders')).toContainText('¥129.00')
  await page.screenshot({
    path: 'test-results/frontend-orders-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByLabel('搜索订单号或套餐').fill('no-such-order')
  await expect(
    page.locator('.mobile-orders').getByText('没有符合当前搜索或状态的订单'),
  ).toBeVisible()
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(update).toBeVisible()
  await page.locator('.mobile-orders .ant-pagination-next button').click()
  await expect(page.locator('.mobile-orders')).toContainText('Earlier plan 7')
  await expect(update).toHaveCount(0)
  await page.getByLabel('搜索订单号或套餐').fill(' ChatGPT Plus ')
  await expect(update).toBeVisible()
})

test('security load errors can be retried and wallet follows enabled payment channels', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, `ui-security-${Date.now()}@example.com`)
  await page.route(
    '**/api/security',
    (route) => route.fulfill({ status: 503, json: { error: '暂时无法加载安全设置' } }),
    { times: 1 },
  )
  await page.goto('/security')
  await expect(page.getByText('暂时无法加载安全设置')).toBeVisible()
  await page.getByRole('button', { name: /重\s*试/ }).click()
  await expect(page.getByRole('button', { name: '添加 Passkey' })).toBeVisible()
  const bootstrap = await (await page.request.get('/api/bootstrap')).json()
  let online = true
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        settings: { ...bootstrap.settings, alipay: false, wechat: online, crypto: false },
      },
    }),
  )
  await page.goto('/wallet')
  await page
    .getByRole('button', { name: /充值余额/ })
    .first()
    .click()
  await expect(page.getByRole('radio', { name: /微信/ })).toBeChecked()
  await expect(page.getByLabel('充值金额（元）')).toBeVisible()
  await page.getByLabel('充值金额（元）').fill('200')
  await page.getByLabel('充值金额（元）').press('Enter')
  await expect(page).toHaveURL(/\/orders\/o_/)
  await page.getByRole('button', { name: '获取支付信息' }).click()
  await page.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(page.getByRole('heading', { name: '充值余额已到账。' })).toBeVisible()
  online = false
  await page.goto('/wallet')
  await page
    .getByRole('button', { name: /充值余额/ })
    .first()
    .click()
  await expect(page.getByText('在线支付暂未开放', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建充值订单' })).toBeDisabled()
  await page.goto('/checkout?product=plus')
  await page.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await page.getByRole('button', { name: /验证账号并确认价格/ }).click()
  await expect(page.getByRole('button', { name: /确认订单/ })).toBeDisabled()
  await page.getByRole('checkbox', { name: /使用账户余额抵扣/ }).check()
  await expect(page.getByRole('button', { name: /确认订单/ })).toBeEnabled()
  await page.getByRole('button', { name: /确认订单/ }).click()
  await expect(page.getByRole('heading', { name: '已收到付款，正在为你充值。' })).toBeVisible()
})

test('order polling errors preserve the current order and session draft', async ({ page }) => {
  await page.clock.install()
  let fail = false
  await page.route('**/api/orders/o_review_recovery', (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: '服务暂不可用' } })
      : route.fulfill({
          json: {
            id: 'o_review_recovery',
            kind: 'purchase',
            status: 'needs_session',
            productName: 'ChatGPT Plus',
            email: 'recovery@example.com',
            contactEmail: 'contact@example.com',
            amount: 12900,
            externalAmount: 12900,
            balanceAmount: 0,
            channel: 'wechat',
            createdAt: new Date().toISOString(),
          },
        }),
  )
  await page.goto('/orders/o_review_recovery')
  const session = page.getByLabel('账号会话信息（Session）', { exact: true })
  await session.fill('draft account information')
  fail = true
  await page.clock.fastForward(8000)
  await expect(page.getByText('订单状态暂未更新')).toBeVisible()
  await expect(session).toHaveValue('draft account information')
  fail = false
  await page.getByRole('button', { name: /重\s*试/ }).click()
  await expect(page.getByText('订单状态暂未更新')).toHaveCount(0)
  await expect(session).toHaveValue('draft account information')
  await page.unroute('**/api/orders/o_review_recovery')
  await page.route('**/api/orders/o_review_recovery', (route) =>
    route.fulfill({ status: 404, json: { error: '订单不存在或无权访问' } }),
  )
  await page.clock.fastForward(8000)
  await expect(page.getByText('订单不存在或无权访问')).toBeVisible()
  await expect(session).toHaveCount(0)
})

test('switching accounts clears the previous wallet before the next account loads', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, `ui-switch-a-${Date.now()}@example.com`)
  const account = await (await page.request.get('/api/account')).json()
  await page.route('**/api/account', (route) =>
    route.fulfill({ json: { ...account, balance: 32100 } }),
  )
  await page.goto('/wallet')
  await expect(page.locator('.wallet-number')).toHaveText('¥321.00')
  await page.getByRole('button', { name: '账号菜单' }).click()
  await page.getByRole('menuitem', { name: /退出登录/ }).click()
  await expect(page.locator('.wallet-number')).toHaveCount(0)
  await page.unroute('**/api/account')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/account', async (route) => {
    await gate
    await route.continue()
  })
  await login(page, `ui-switch-b-${Date.now()}@example.com`)
  await expect(page.locator('main .ant-skeleton')).toBeVisible()
  await expect(page.locator('.wallet-number')).toHaveCount(0)
  release()
  await expect(page.locator('.wallet-number')).toHaveText('¥0.00')
})

test('public and signed-in frontend pages fit narrow and desktop viewports', async ({ page }) => {
  test.setTimeout(120000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const path of [
    '/',
    '/compare',
    '/guide',
    '/plans/plus',
    '/help/payment',
    '/privacy',
    '/terms',
    '/checkout?product=plus',
    '/checkout?product=missing',
  ]) {
    await page.goto(path)
    await expect(page.locator('main').or(page.locator('.ant-result')).first()).toBeVisible()
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${path}: ${width}`,
      ).toBe(true)
    }
  }
  await page.goto('/')
  await login(page, `ui-layout-${Date.now()}@example.com`)
  for (const path of ['/account', '/wallet', '/referral', '/security']) {
    await page.goto(path)
    await expect(page.locator('main .ant-skeleton')).toHaveCount(0)
    await expect(page.locator('main .ant-spin-spinning')).toHaveCount(0)
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${path}: ${width}`,
      ).toBe(true)
      if ([375, 1440].includes(width))
        await page.screenshot({
          path: `test-results/frontend-${path.slice(1)}-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        })
    }
  }
  expect(errors).toEqual([])
})
