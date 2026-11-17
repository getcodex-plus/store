import { expect, test, type Page } from '@playwright/test'
import { openAdminPage } from './admin-helpers'
import { demoSession } from '../src/lib'
import { db } from '../src/server/db'

async function loginWithEmailOtp(page: Page, email: string) {
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('you@example.com').fill(email)
  await dialog.getByRole('button', { name: '获取验证码', exact: true }).click()
  const alert = dialog.getByText(/本地演示验证码：/)
  await expect(alert).toBeVisible()
  const code = (await alert.textContent())!.match(/\d{6}/)![0]
  await dialog.getByPlaceholder('6 位验证码', { exact: true }).fill(code)
  await dialog.getByRole('button', { name: /登录 \/ 注册/ }).click()
  await expect(dialog).toBeHidden()
}

test.afterAll(async () => {
  await db.$disconnect()
})

test('end-to-end coupon link activation, storefront price diff, checkout live switch, and KOL affiliate commission', async ({
  browser,
}) => {
  const kolEmail = `kol-${Date.now()}@example.com`
  const buyerContactEmail = `buyer-${Date.now()}@example.com`
  const targetGptEmail = `gpt-${Date.now()}@example.com`

  // 1. Register KOL user first so Admin can bind an exclusive affiliate coupon to kolEmail
  const kolContext = await browser.newContext()
  const kolPage = await kolContext.newPage()
  await kolPage.goto('/')
  await loginWithEmailOtp(kolPage, kolEmail)

  // 2. Admin logs in and creates SAVE20 (¥20 off) and KOL35 (¥35 off + 8% affiliate commission)
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/')
  await loginWithEmailOtp(adminPage, 'admin@example.com')
  await adminPage.goto('/admin')
  await openAdminPage(adminPage, '优惠码管理')

  const modal = adminPage.getByRole('dialog')

  // Create SAVE20
  await adminPage.getByRole('button', { name: '新增优惠码' }).click()
  await expect(modal).toBeVisible()
  await modal.getByLabel('优惠码编码').fill('save20')
  await expect(modal.getByLabel('优惠码编码')).toHaveValue('SAVE20')
  await modal.getByLabel('活动名称').fill('春季 Plus 立减')
  await modal.getByLabel('立减金额（元）').fill('20')
  await modal.getByRole('button', { name: '创建优惠码' }).click()
  await expect(modal).toBeHidden()
  await expect(adminPage.getByRole('row').filter({ hasText: 'SAVE20' })).toContainText('生效中')

  // Create KOL35 bound to kolEmail at 8%
  await adminPage.getByRole('button', { name: '新增优惠码' }).click()
  await expect(modal).toBeVisible()
  await modal.getByLabel('优惠码编码').fill('kol35')
  await modal.getByLabel('活动名称').fill('KOL 粉丝专属立减')
  await modal.getByLabel('立减金额（元）').fill('35')
  await modal.getByLabel('绑定专属推广员邮箱（可选）').fill(kolEmail)
  await modal.getByLabel('推广员专属返佣比例（%）').fill('8')
  await modal.getByRole('button', { name: '创建优惠码' }).click()
  await expect(modal).toBeHidden()
  await expect(adminPage.getByRole('row').filter({ hasText: 'KOL35' })).toContainText(kolEmail)

  // 3. KOL sees exclusive coupon card on /referral
  await kolPage.goto('/referral')
  await expect(kolPage.getByText('你的专属推广优惠码')).toBeVisible()
  await expect(kolPage.locator('.affiliate-coupon-item')).toContainText('KOL35')
  await expect(kolPage.locator('.affiliate-coupon-item')).toContainText('8%')

  // 4. Fresh visitor opens /?coupon=SAVE20 -> banner + crossed-out price diff across storefront
  const visitorContext = await browser.newContext()
  const visitorPage = await visitorContext.newPage()
  await visitorPage.goto('/?coupon=SAVE20')

  const activeBanner = visitorPage.locator('.coupon-banner').first()
  await expect(activeBanner).toContainText('已启用优惠码')
  await expect(activeBanner).toContainText('SAVE20')
  await expect(activeBanner).toContainText('立减 ¥20')

  // Home Hero entry price: ¥135.00 crossed out -> ¥115.00 + 省 ¥20.00
  await expect(visitorPage.locator('.entry-price')).toContainText('¥135.00')
  await expect(visitorPage.locator('.entry-price')).toContainText('¥115.00')

  // Home Plus PlanCard: crossed-out original price + discounted price + 已省 ¥20.00
  const plusCard = visitorPage
    .locator('.plan-card')
    .filter({ has: visitorPage.getByRole('heading', { name: 'ChatGPT Plus', exact: true }) })
  await expect(plusCard.locator('.price-original')).toHaveText('¥135.00')
  await expect(plusCard.locator('.price')).toContainText('¥115.00')
  await expect(plusCard.locator('.coupon-diff-badge')).toContainText('已省 ¥20.00')

  // Navigate to /compare WITHOUT ?coupon= query param -> persisted coupon still renders price diff
  await visitorPage.goto('/compare')
  const plusCompareRow = visitorPage.getByRole('row').filter({ hasText: 'ChatGPT Plus' })
  await expect(plusCompareRow.locator('.comparison-price-stack')).toContainText('¥115.00')
  await expect(plusCompareRow.locator('.price-original')).toHaveText('¥135.00')

  // Navigate to /plans/plus -> detail price diff rendered
  await visitorPage.goto('/plans/plus')
  await expect(visitorPage.locator('.detail-price')).toContainText('¥115.00')
  await expect(visitorPage.locator('.detail-price .price-original')).toHaveText('¥135.00')
  await expect(visitorPage.locator('.detail-price .coupon-diff-badge')).toContainText('已省 ¥20.00')

  // Invalid coupon link shows dismissible warning while keeping SAVE20 active
  await visitorPage.goto('/?coupon=INVALID_NO_SUCH_CODE')
  const invalidBanner = visitorPage.locator('.coupon-banner.invalid')
  await expect(invalidBanner).toContainText('INVALID_NO_SUCH_CODE')
  await invalidBanner.getByRole('button', { name: '知道了' }).click()
  await expect(invalidBanner).toHaveCount(0)
  await expect(visitorPage.locator('.coupon-banner')).toContainText('SAVE20')

  // 5. Checkout flow: Step 1 preview -> verify Session -> Step 2 switch SAVE20 -> KOL35 without re-verifying Session
  await visitorPage.goto('/checkout?product=plus')
  await expect(visitorPage.locator('.checkout-coupon-box')).toContainText('SAVE20')
  await expect(visitorPage.locator('.checkout-coupon-box')).toContainText('预计立省 ¥20.00')

  await visitorPage.getByLabel('联系邮箱', { exact: true }).fill(buyerContactEmail)
  const sessionInput = visitorPage.getByLabel('账号会话信息', { exact: true })
  await sessionInput.fill(demoSession(targetGptEmail))
  await visitorPage.getByRole('checkbox', { name: /我确认有权使用该账号/ }).check()
  await visitorPage.getByRole('button', { name: /验证账号并确认价格/ }).click()

  await expect(visitorPage.getByRole('heading', { name: '核对订单，选择支付方式' })).toBeVisible()
  await expect(visitorPage.locator('.order-summary')).toContainText('¥135.00')
  await expect(visitorPage.locator('.order-summary')).toContainText('SAVE20')
  await expect(visitorPage.locator('.order-summary')).toContainText('¥115.00')

  // Switch coupon on Step 2 to KOL35 without re-entering ChatGPT Session!
  await visitorPage
    .locator('.checkout-coupon-box')
    .getByRole('button', { name: /更\s*换/ })
    .click()
  await visitorPage.getByLabel('优惠码', { exact: true }).fill('kol35')
  await visitorPage
    .locator('.checkout-coupon-box')
    .getByRole('button', { name: /应\s*用/ })
    .click()

  await expect(visitorPage.locator('.checkout-coupon-box')).toContainText('KOL35')
  await expect(visitorPage.locator('.checkout-coupon-box')).toContainText('本单已减 ¥35.00')
  await expect(visitorPage.locator('.order-summary')).toContainText('已省 ¥35.00 · KOL35')
  await expect(visitorPage.locator('.order-summary')).toContainText('¥100.00')
  await expect(visitorPage.locator('.checkout-page')).toContainText('−¥35.00')
  // Confirm we are STILL on Step 2 without losing verified ChatGPT account
  await expect(visitorPage.getByRole('heading', { name: '核对订单，选择支付方式' })).toBeVisible()

  // Submit order and complete demo payment
  await visitorPage.getByRole('button', { name: /确认订单/ }).click()
  await expect(visitorPage).toHaveURL(/\/orders\/o_/)
  const orderId = new URL(visitorPage.url()).pathname.split('/').pop()!

  await expect(visitorPage.getByText('应付 ¥100.00')).toBeVisible()
  await expect(visitorPage.getByText(/优惠码 KOL35 已减 ¥35\.00/)).toBeVisible()
  await visitorPage.getByRole('button', { name: '获取支付信息' }).click()
  await visitorPage.getByRole('button', { name: '模拟付款成功' }).click()
  await expect(
    visitorPage.getByRole('heading', { name: /充值完成，开始使用吧|已收到付款，正在为你充值/ }),
  ).toBeVisible()

  // Order detail card displays original price, coupon discount, and post-discount total
  const detailCard = visitorPage.locator('.ant-card').filter({ hasText: '订单详情' })
  await expect(detailCard).toContainText('套餐原价')
  await expect(detailCard).toContainText('¥135.00')
  await expect(detailCard).toContainText('−¥35.00（KOL35）')
  await expect(detailCard).toContainText('折后总价')
  await expect(detailCard).toContainText('¥100.00')

  // When order finishes fulfillment in demo mode, KOL receives 8% of ¥100.00 = ¥8.00 (800 fen)
  await expect
    .poll(
      async () => {
        const comm = await db.commission.findUnique({ where: { orderId } })
        return comm?.amount ?? null
      },
      { timeout: 10000 },
    )
    .toBe(800)

  // Admin Orders table also shows coupon code and discount amount
  await openAdminPage(adminPage, '订单管理')
  const adminOrderRow = adminPage.getByRole('row').filter({ hasText: targetGptEmail })
  await expect(adminOrderRow).toContainText('KOL35')
  await expect(adminOrderRow).toContainText('¥100.00')

  await visitorContext.close()
  await adminContext.close()
  await kolContext.close()
})
