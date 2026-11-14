import { openAdminPage } from './admin-helpers'
import { test, expect, type Page } from '@playwright/test'
import { defaultReferralTiers, referralProgress } from '../src/referral'
import type { AccountData, Bootstrap, Settings, User, Withdrawal } from '../src/types'
import { defaultWithdrawalChannels } from '../src/withdrawals'

const user = {
  id: 'preview-user',
  email: 'referral@example.com',
  role: 'user' as const,
  referralCode: 'a123456789',
  createdAt: '2026-11-14T00:00:00Z',
  disabled: false,
  permissions: [],
}
async function fixture(page: Page, available = 35000, settings: Partial<Settings> = {}) {
  const bootstrap: Bootstrap = {
    user,
    mode: 'demo',
    products: [],
    turnstile: { siteKey: '', login: false, purchase: false },
    settings: {
      rateBps: defaultReferralTiers[0].rateBps,
      referralTiers: defaultReferralTiers,
      settlementDays: 7,
      firstOrderOnly: true,
      supportEmail: '',
      alipay: true,
      wechat: true,
      crypto: true,
      fiatProvider: 'xorpay',
      emailProvider: 'resend',
      ...settings,
    },
  }
  const account: AccountData = {
    orders: [],
    commissions: [],
    withdrawals: [],
    invitedCount: 9,
    referral: referralProgress(8, bootstrap.settings),
    available,
    pending: 8000,
    settled: 50000,
    withdrawn: 10000,
    frozen: 5000,
    shortfall: 0,
    balance: 100000,
    ledger: [],
  }
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: bootstrap }))
  await page.route('**/api/account', (route) => route.fulfill({ json: account }))
  return { account, bootstrap }
}

test('admin edits referral levels, retains failed edits and restores automatic calculation', async ({
  page,
}) => {
  const { bootstrap } = await fixture(page)
  bootstrap.user = {
    ...user,
    id: 'preview-admin',
    role: 'admin',
    permissions: ['admin:access', 'users:read', 'users:write'],
  }
  const target: User = { ...user, referralTierId: null }
  await page.route(/\/api\/admin(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        users: [target],
        products: [],
        orders: [],
        commissions: [],
        withdrawals: [],
        settings: bootstrap.settings,
        audit: [],
        inventory: [],
        roles: [],
        integrations: [],
      },
    }),
  )
  const submissions: unknown[] = []
  await page.route('**/api/admin/users', async (route) => {
    const input = route.request().postDataJSON()
    submissions.push(input)
    if (submissions.length === 1)
      return route.fulfill({ status: 400, json: { error: '返佣等级不存在，请刷新后重新选择' } })
    target.referralTierId = input.referralTierId
    await route.fulfill({ json: { saved: true } })
  })
  await page.goto('/admin')
  await openAdminPage(page, '用户管理')
  await expect(page.getByRole('cell', { name: '自动计算', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(target.email)
  await dialog.getByLabel('返佣等级', { exact: true }).click()
  await page.getByRole('option', { name: '邀请合伙人 · 5%', exact: true }).click()
  await dialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(page.getByText('返佣等级不存在，请刷新后重新选择', { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.ant-select')).toContainText('邀请合伙人 · 5%')
  await dialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('cell', { name: '邀请合伙人 · 5%（指定）', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.locator('.ant-select')).toContainText('邀请合伙人 · 5%')
  await dialog.getByLabel('返佣等级', { exact: true }).click()
  await page.getByRole('option', { name: '自动计算（按有效邀请人数）', exact: true }).click()
  await dialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('cell', { name: '自动计算', exact: true })).toBeVisible()
  expect(submissions).toEqual([
    { id: target.id, referralTierId: 'partner' },
    { id: target.id, referralTierId: 'partner' },
    { id: target.id, referralTierId: null },
  ])
  bootstrap.user.permissions = ['admin:access', 'users:read']
  await page.reload()
  await openAdminPage(page, '用户管理')
  await expect(page.getByRole('cell', { name: '只读', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0)
})

test('assigned referral levels explain manual rates without automatic promotion progress', async ({
  page,
}) => {
  const { account, bootstrap } = await fixture(page)
  account.referral = referralProgress(50, bootstrap.settings, 'sharer')
  await page.goto('/referral')
  await expect(page.getByRole('heading', { name: /分享达人/ })).toBeVisible()
  await expect(page.getByText('当前等级由管理员指定。', { exact: false })).toBeVisible()
  await expect(
    page.getByText('当前按指定等级返现，不随有效邀请人数自动调整。', { exact: false }),
  ).toBeVisible()
  await expect(page.locator('.referral-levels .ant-progress')).toHaveCount(0)
  await expect(page.getByText('已达到最高等级', { exact: false })).toHaveCount(0)
})

test('referral tiers and withdrawal form preserve the invitation-only limit on desktop and mobile', async ({
  page,
}) => {
  const { account } = await fixture(page)
  const submissions: Record<string, unknown>[] = []
  await page.route('**/api/wallet/withdraw', async (route) => {
    const input = route.request().postDataJSON()
    submissions.push(input)
    expect(input.amount).toBeLessThanOrEqual(account.available)
    account.available -= input.amount
    account.frozen += input.amount
    account.withdrawals.push({
      id: 'w_preview',
      userId: user.id,
      ...input,
      feeAmount: input.expectedFeeAmount,
      feeRateBps: 0,
      fixedFee: 0,
      netAmount: input.amount - input.expectedFeeAmount,
      status: 'pending',
      note: '',
      payoutReference: '',
      payoutAmount: null,
      reviewerId: null,
      reviewedAt: null,
      createdAt: new Date().toISOString(),
    })
    await route.fulfill({ json: { submitted: true } })
  })
  await page.goto('/referral')
  await expect(page.getByRole('heading', { name: /分享达人/ })).toBeVisible()
  await expect(page.getByText('再邀请 12 位可升至推荐官', { exact: false })).toBeVisible()
  await expect(page.locator('.referral-level-percent')).toHaveText(['2%', '3%', '4%', '5%'])
  for (const width of [1440, 760, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'test-results/referral-tiers-desktop.png', fullPage: true })
  await page.locator('.referral-levels').screenshot({ path: 'test-results/referral-levels.png' })
  await page.getByRole('button', { name: '申请提现', exact: true }).click()
  const form = page.getByRole('dialog')
  await expect(
    form.locator('.withdrawal-summary').getByText('¥350.00', { exact: true }),
  ).toBeVisible()
  await expect(form.getByText('仅限已结算邀请收益。充值和退款余额仅可消费。')).toBeVisible()
  await form.getByRole('button', { name: '全部提现' }).click()
  await expect(form.getByRole('spinbutton', { name: '提现金额（元）' })).toHaveValue('350.00')
  await form.getByLabel('收款人姓名').fill('张小明')
  await form.getByLabel('支付宝收款账号').fill('pay@example.com')
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(form.getByText('请核对并确认收款信息', { exact: true })).toBeVisible()
  expect(submissions).toHaveLength(0)
  await form.getByRole('checkbox').check()
  await expect(form.getByText('请核对并确认收款信息', { exact: true })).toBeHidden()
  await form.screenshot({ path: 'test-results/withdrawal-form-desktop.png' })
  await page.setViewportSize({ width: 375, height: 1000 })
  await expect.poll(() => form.evaluate((el) => el.scrollWidth <= window.innerWidth)).toBe(true)
  await form.screenshot({ path: 'test-results/withdrawal-form-mobile.png' })
  await page.setViewportSize({ width: 320, height: 1000 })
  await expect.poll(() => form.evaluate((el) => el.scrollWidth <= window.innerWidth)).toBe(true)
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(form).toBeHidden()
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toMatchObject({ amount: 35000, confirmed: true, recipientName: '张小明' })
  await page.goto('/wallet')
  await expect(page.getByRole('button', { name: '申请提现', exact: true })).toBeDisabled()
  await page.getByRole('tab', { name: '提现记录' }).click()
  await expect(page.getByRole('cell', { name: '待审核', exact: true })).toBeVisible()
})

test('USDT requires network validation and stale balances produce a visible recoverable error', async ({
  page,
}) => {
  const { account } = await fixture(page)
  let submissions = 0
  await page.route('**/api/wallet/withdraw', async (route) => {
    submissions++
    expect(route.request().postDataJSON()).toMatchObject({
      method: 'USDT',
      network: 'ERC20',
      account: `0x${'a'.repeat(40)}`,
    })
    account.available = 1000
    account.frozen = 39000
    await route.fulfill({ status: 409, json: { error: '可提现邀请收益不足，请刷新额度' } })
  })
  await page.goto('/wallet')
  await page.getByRole('button', { name: '申请提现', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('收款方式').click()
  await page.getByRole('option', { name: 'USDT', exact: true }).click()
  await expect(form.getByLabel('收款网络')).toBeVisible()
  await expect(form.getByText('申请金额以人民币计', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: '全部提现' }).click()
  await form.getByLabel('收款人姓名').fill('张小明')
  await form.getByLabel('收款网络').click()
  await page.getByRole('option', { name: 'Ethereum', exact: true }).click()
  await form.getByLabel('USDT 收款地址').fill('incorrect-address')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(form.getByText('地址与所选网络格式不匹配，请核对')).toBeVisible()
  expect(submissions).toBe(0)
  await form.getByLabel('USDT 收款地址').fill(`0x${'a'.repeat(40)}`)
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(form.getByText('可提现邀请收益不足，请刷新额度', { exact: true })).toBeVisible()
  await expect(form.getByLabel('收款人姓名')).toHaveValue('张小明')
  await expect(form.getByRole('button', { name: '确认并提交提现申请' })).toBeDisabled()
  expect(submissions).toBe(1)
})

test('only enabled USDT networks appear, with independent minimums and combined fees', async ({
  page,
}) => {
  const config = structuredClone(defaultWithdrawalChannels)
  config.alipay = false
  config.wechat = false
  config.networks = { ERC20: false, TRC20: false, BSC: true, Polygon: true }
  config.rules.BSC = { minimum: 5000, feeRateBps: 100, fixedFee: 100 }
  config.rules.Polygon = { minimum: 10000, feeRateBps: 200, fixedFee: 200 }
  await fixture(page, 35000, { withdrawalChannels: config })
  const submissions: Record<string, unknown>[] = []
  await page.route('**/api/wallet/withdraw', async (route) => {
    submissions.push(route.request().postDataJSON())
    await route.fulfill({ json: { submitted: true } })
  })
  await page.goto('/wallet')
  await page.getByRole('button', { name: '申请提现', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('收款方式').click()
  await expect(page.getByRole('option')).toHaveText(['USDT'])
  await page.getByRole('option', { name: 'USDT', exact: true }).click()
  await form.getByLabel('收款网络').click()
  await expect(page.getByRole('option')).toHaveText(['BNB Smart Chain', 'Polygon'])
  await page.getByRole('option', { name: 'BNB Smart Chain', exact: true }).click()
  await form.getByLabel('提现金额（元）', { exact: true }).fill('50')
  await form.getByLabel('收款人姓名').fill('张小明')
  await form.getByLabel('USDT 收款地址').fill(`0x${'a'.repeat(40)}`)
  await expect(form.getByTestId('withdrawal-fee')).toHaveText('¥1.50')
  await expect(form.getByTestId('withdrawal-net')).toHaveText('¥48.50')
  await form.getByRole('checkbox').check()
  await form.getByLabel('收款网络').click()
  await page.getByRole('option', { name: 'Polygon', exact: true }).click()
  await expect(form.getByLabel('USDT 收款地址')).toHaveValue('')
  await expect(form.getByRole('checkbox')).not.toBeChecked()
  await expect(form.getByText('所选提现渠道最低起提 ¥100.00', { exact: true })).toBeVisible()
  await form.getByLabel('提现金额（元）', { exact: true }).fill('100')
  await form.getByLabel('USDT 收款地址').fill(`0x${'a'.repeat(40)}`)
  await expect(form.getByTestId('withdrawal-fee')).toHaveText('¥4.00')
  await expect(form.getByTestId('withdrawal-net')).toHaveText('¥96.00')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(form).toBeHidden()
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toMatchObject({
    amount: 10000,
    expectedFeeAmount: 400,
    network: 'Polygon',
  })
})

test('closed channels and unavailable minimums disable new applications on wallet and referral pages', async ({
  page,
}) => {
  const config = structuredClone(defaultWithdrawalChannels)
  config.alipay = false
  config.wechat = false
  config.usdt = false
  const { bootstrap } = await fixture(page, 5000, { withdrawalChannels: config })
  for (const path of ['/wallet', '/referral']) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: '申请提现', exact: true })).toBeDisabled()
    await expect(page.getByText('提现渠道暂未开放，请稍后再试', { exact: true })).toBeVisible()
  }
  config.usdt = true
  config.networks = { ERC20: false, TRC20: false, BSC: true, Polygon: false }
  config.rules.BSC.minimum = 10000
  config.rules.alipay.minimum = 100
  bootstrap.settings.withdrawalChannels = config
  await page.goto('/wallet')
  await expect(page.getByRole('button', { name: '申请提现', exact: true })).toBeDisabled()
  await expect(page.getByText('再结算 ¥50.00 即可申请', { exact: true })).toBeVisible()
})

test('updated fees require a fresh confirmation and channel closure clears a stale selection', async ({
  page,
}) => {
  const config = structuredClone(defaultWithdrawalChannels)
  config.rules.alipay = { minimum: 1000, feeRateBps: 100, fixedFee: 100 }
  const { bootstrap } = await fixture(page, 35000, { withdrawalChannels: config })
  let submissions = 0
  await page.route('**/api/wallet/withdraw', async (route) => {
    submissions++
    if (submissions === 1) {
      expect(route.request().postDataJSON().expectedFeeAmount).toBe(200)
      bootstrap.settings.withdrawalChannels!.rules.alipay.feeRateBps = 200
      await route.fulfill({
        status: 409,
        json: { error: '提现手续费已调整，请核对新的手续费后重新确认' },
      })
    } else {
      expect(route.request().postDataJSON().expectedFeeAmount).toBe(300)
      bootstrap.settings.withdrawalChannels!.alipay = false
      await route.fulfill({
        status: 409,
        json: { error: '此提现渠道暂未开放，请选择其他收款方式' },
      })
    }
  })
  await page.goto('/wallet')
  await page.getByRole('button', { name: '申请提现', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('提现金额（元）', { exact: true }).fill('100')
  await form.getByLabel('收款人姓名').fill('张小明')
  await form.getByLabel('支付宝收款账号').fill('pay@example.com')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(
    form.getByText('提现手续费已调整，请核对新的手续费后重新确认', { exact: true }),
  ).toBeVisible()
  await expect(form.getByTestId('withdrawal-fee')).toHaveText('¥3.00')
  await expect(form.getByTestId('withdrawal-net')).toHaveText('¥97.00')
  await expect(form.getByRole('checkbox')).not.toBeChecked()
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '确认并提交提现申请' }).click()
  await expect(
    form.getByText('此提现渠道暂未开放，请选择其他收款方式', { exact: true }),
  ).toBeVisible()
  await expect(form.getByRole('button', { name: '确认并提交提现申请' })).toBeDisabled()
  await form.getByLabel('收款方式').click()
  await expect(page.getByRole('option')).toHaveText(['微信', 'USDT'])
  expect(submissions).toBe(2)
})

test('admin sees net-based USDT estimates, can refresh and fill them, and keeps the actual payout editable', async ({
  page,
}) => {
  const { bootstrap } = await fixture(page)
  bootstrap.user = {
    ...user,
    id: 'preview-admin',
    role: 'admin',
    permissions: ['admin:access', 'withdrawals:read', 'withdrawals:write'],
  }
  const withdrawal: Withdrawal = {
    id: 'w_estimate',
    userId: user.id,
    amount: 10000,
    method: 'USDT',
    network: 'BSC',
    account: `0x${'a'.repeat(40)}`,
    recipientName: '张小明',
    feeAmount: 300,
    feeRateBps: 200,
    fixedFee: 100,
    netAmount: 9700,
    status: 'processing',
    note: '',
    payoutReference: '',
    payoutAmount: null,
    reviewerId: 'preview-admin',
    reviewedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
  await page.route(/\/api\/admin(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        users: [user, bootstrap.user],
        products: [],
        orders: [],
        commissions: [],
        withdrawals: [withdrawal],
        settings: bootstrap.settings,
        audit: [],
        inventory: [],
        roles: [],
        integrations: [],
      },
    }),
  )
  let refreshes = 0
  await page.route('**/api/admin/withdrawals/estimate', async (route) => {
    const input = route.request().postDataJSON()
    expect(input.id).toBe(withdrawal.id)
    if (input.refresh) refreshes++
    if (refreshes === 2) {
      await route.fulfill({
        status: 503,
        json: { error: 'USDT 参考汇率暂不可用，请稍后刷新；仍可按实际打款数量登记' },
      })
      return
    }
    await route.fulfill({
      json: {
        withdrawalId: withdrawal.id,
        netAmount: 9700,
        estimatedUsdt: refreshes === 0 ? '13.857143' : '14.923077',
        rate: refreshes === 0 ? 7 : 6.5,
        source: 'Currency API · jsDelivr',
        sourceDate: '2026-11-13',
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        refreshFailed: false,
      },
    })
  })
  await page.goto('/admin')
  await openAdminPage(page, '提现审核')
  await expect(page.getByRole('cell', { name: 'BNB Smart Chain', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '登记打款结果', exact: true }).click()
  const form = page.getByRole('dialog')
  await expect(form.locator('.ant-statistic-content-value')).toHaveText('13.857143')
  await expect(form.getByText('本单净额 ¥97.00 ÷ 7 CNY/USDT', { exact: true })).toBeVisible()
  await expect(form.getByText(/来源：Currency API · jsDelivr/)).toBeVisible()
  await form.getByLabel('处理结果').click()
  await page.getByText('已完成实际打款，登记结果', { exact: true }).last().click()
  await expect(form.getByLabel('实际到账 USDT 数量')).toHaveValue('')
  await form.getByRole('button', { name: '填入参考数量', exact: true }).click()
  await expect(form.getByLabel('实际到账 USDT 数量')).toHaveValue('13.857143')
  await form.getByLabel('实际到账 USDT 数量').fill('13.8')
  await form.getByRole('button', { name: '刷新参考数量', exact: true }).click()
  await expect(form.locator('.ant-statistic-content-value')).toHaveText('14.923077')
  await expect(form.getByLabel('实际到账 USDT 数量')).toHaveValue('13.800000')
  await form.getByRole('button', { name: '刷新参考数量', exact: true }).click()
  await expect(
    form.getByText('USDT 参考汇率暂不可用，请稍后刷新；仍可按实际打款数量登记', { exact: true }),
  ).toBeVisible()
  await expect(form.locator('.ant-statistic-content-value')).toHaveCount(0)
  await expect(form.getByRole('button', { name: '填入参考数量', exact: true })).toBeDisabled()
  await expect(form.getByLabel('实际到账 USDT 数量')).toHaveValue('13.800000')
})
