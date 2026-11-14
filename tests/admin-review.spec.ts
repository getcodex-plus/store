import { expect, test } from '@playwright/test'
import { openAdminPage } from './admin-helpers'

test('admin screens stay usable at narrow widths and refresh preserves settings drafts', async ({
  page,
}) => {
  test.setTimeout(120000)
  await page.goto('/admin')
  await page.getByRole('button', { name: '管理员登录' }).click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const code = page.getByText(/本地演示验证码：/)
  await expect(code).toBeVisible()
  await page
    .getByPlaceholder('6 位验证码', { exact: true })
    .fill((await code.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('heading', { name: '运营概览', exact: true })).toBeVisible()
  const screens = [
    '运营概览',
    '订单管理',
    '商品管理',
    '兑换码管理',
    '导入批次',
    '用户管理',
    '用户钱包',
    '邀请与返现',
    '提现审核',
    '支付与服务',
    '网站设置',
    '角色与权限',
    '操作日志',
    '风控记录',
  ]
  for (const [index, screen] of screens.entries()) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    if (index > 0) await openAdminPage(page, screen)
    await expect(page.getByRole('button', { name: /刷新$/ })).not.toHaveClass(/ant-btn-loading/)
    await expect(page.locator('.admin-content .ant-skeleton')).toHaveCount(0)
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${screen} at ${width}px`,
      ).toBe(true)
      if (screen === '运营概览') {
        const metrics = await page.evaluate(() => ({
          noticeGap: parseFloat(
            getComputedStyle(document.querySelector('.admin-content > .ant-alert')!).marginBottom,
          ),
          captionSize: parseFloat(
            getComputedStyle(document.querySelector('.admin-stats .tiny')!).fontSize,
          ),
        }))
        expect(metrics.noticeGap).toBeGreaterThanOrEqual(24)
        expect(metrics.captionSize).toBeGreaterThanOrEqual(12)
      }
      if (
        ['运营概览', '角色与权限', '网站设置', '订单管理'].includes(screen) &&
        [375, 1440].includes(width)
      )
        await page.screenshot({ path: `test-results/admin-${index}-${width}.png`, fullPage: true })
    }
  }
  await openAdminPage(page, '网站设置')
  const support = page.getByLabel('支持邮箱', { exact: true })
  await support.fill('unsaved-review@example.com')
  const refreshed = page.waitForResponse(/\/api\/admin\?/)
  await page.getByRole('button', { name: /刷新$/ }).click()
  await refreshed
  await expect(page.getByRole('button', { name: /刷新$/ })).not.toHaveClass(/ant-btn-loading/)
  await expect(support).toHaveValue('unsaved-review@example.com')
  await openAdminPage(page, '订单管理')
  await openAdminPage(page, '网站设置')
  await expect(support).toHaveValue('unsaved-review@example.com')
  const stored = await (await page.request.get('/api/admin')).json()
  expect(stored.settings.supportEmail).not.toBe('unsaved-review@example.com')

  await openAdminPage(page, '订单管理')
  const search = page.getByLabel('搜索订单、联系邮箱、充值账号或套餐')
  const searched = page.waitForResponse((response) =>
    response.url().includes('search=no-matching-delivery-review'),
  )
  await search.fill('no-matching-delivery-review')
  expect((await (await searched).json()).pagination.total).toBe(0)
  await expect(page.locator('.ant-table-placeholder')).toBeVisible()
  const cleared = page.waitForResponse(
    (response) =>
      response.url().includes('section=orders') &&
      new URL(response.url()).searchParams.get('search') === '',
  )
  await search.fill('')
  await cleared
  await expect(page.getByRole('button', { name: /刷新$/ })).not.toHaveClass(/ant-btn-loading/)
  await page.route(
    /\/api\/admin(?:\?.*)?$/,
    (route) => route.fulfill({ status: 503, json: { error: '暂时无法加载，请重试' } }),
    { times: 1 },
  )
  await page.getByRole('button', { name: /刷新$/ }).click()
  await expect(page.getByText('暂时无法加载，请重试')).toBeVisible()
  await page.getByRole('button', { name: /重\s*试/, exact: true }).click()
  await expect(page.getByText('暂时无法加载，请重试')).toHaveCount(0)
})
