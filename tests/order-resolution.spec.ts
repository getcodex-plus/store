import { expect, test, type APIRequestContext } from '@playwright/test'
import { db } from '../src/server/db'
import { id } from '../src/server/crypto'
import { adminOrderView } from '../src/server/data'
import { openAdminPage } from './admin-helpers'

const origin = process.env.E2E_BASE_URL || 'http://localhost:3000'
const headers = { Origin: origin, 'X-GetGPT-Request': '1' }

async function login(request: APIRequestContext, email: string) {
  await request.get('/api/bootstrap')
  expect(
    (
      await request.post('/api/auth/email-otp/send-verification-otp', {
        headers,
        data: { email, type: 'sign-in' },
      })
    ).ok(),
  ).toBe(true)
  const code = await request.post('/api/demo/code', { headers, data: { email } })
  expect(
    (
      await request.post('/api/auth/sign-in/email-otp', {
        headers,
        data: { email, otp: (await code.json()).demoCode },
      })
    ).ok(),
  ).toBe(true)
}

test.afterAll(() => db.$disconnect())

test('operators can verify outcomes, inspect records, and continue to refunds', async ({
  page,
}) => {
  await login(page.request, 'admin@example.com')
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })
  const orders = []
  for (const outcome of ['completed', 'failed']) {
    orders.push(
      await db.order.create({
        data: {
          id: id(),
          userId: admin.id,
          kind: 'purchase',
          status: 'processing',
          fulfillmentStatus: 'uncertain',
          productName: `人工处理 UI ${outcome}`,
          email: 'resolution@example.com',
          contactEmail: admin.email,
          amount: 10000,
          balanceAmount: 10000,
          externalAmount: 0,
          provider: 'balance',
          channel: 'balance',
          rateBps: 0,
          settlementDays: 7,
          firstOrderOnly: true,
        },
      }),
    )
  }
  await page.goto('/admin')
  await openAdminPage(page, '订单管理')
  const row = (outcome: string) =>
    page.getByRole('row').filter({ hasText: `人工处理 UI ${outcome}` })
  const dialog = page.getByRole('dialog')
  for (const outcome of ['completed', 'failed']) {
    await row(outcome).getByRole('button', { name: '人工处理', exact: true }).click()
    await dialog
      .getByRole('radio', { name: outcome === 'completed' ? '已核实成功' : '已核实失败' })
      .check()
    const submit = dialog.getByRole('button', {
      name: outcome === 'completed' ? '确认兑换成功' : '确认兑换失败',
      exact: true,
    })
    await expect(submit).toBeDisabled()
    await dialog.getByLabel('核对依据和处理备注').fill(`上游工单 ${outcome}，已核实账号实际结果`)
    await expect(submit).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /我已核对上游和账号实际结果/ }).check()
    await submit.click()
    await expect(dialog).toBeHidden()
    await expect(row(outcome)).toContainText('人工确认')
    await row(outcome).getByRole('button', { name: '处理记录', exact: true }).click()
    await expect(dialog).toContainText(`上游工单 ${outcome}`)
    await expect(dialog).toContainText('admin@example.com')
    await expect(dialog.getByRole('radio')).toHaveCount(0)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  }
  await expect(row('completed')).toContainText('充值完成')
  await expect(row('failed')).toContainText('充值异常')
  await row('failed').getByRole('button', { name: '处理退款', exact: true }).click()
  await dialog.getByRole('button', { name: '确认退回余额 ¥100.00', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row('failed')).toContainText('已退回钱包')
  await row('failed').getByRole('button', { name: '处理记录', exact: true }).click()
  await expect(dialog).toContainText('上游工单 failed')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  const publicOrders = await (await page.request.get('/api/account')).json()
  expect(JSON.stringify(publicOrders)).not.toContain('上游工单')
  expect(JSON.stringify(publicOrders)).not.toContain('fulfillmentResolution')

  const session = await db.authSession.findFirstOrThrow({
    where: { userId: admin.id },
    orderBy: { createdAt: 'desc' },
  })
  await db.authSession.update({
    where: { id: session.id },
    data: { createdAt: new Date(Date.now() - 11 * 60000) },
  })
  const expired = await page.request.post('/api/admin/orders/resolve', {
    headers,
    data: {
      id: orders[0].id,
      outcome: 'completed',
      note: '重复请求',
      confirmed: true,
      expectedRevision: adminOrderView(orders[0]).resolutionRevision,
    },
  })
  expect(expired.status()).toBe(403)
  expect(await expired.text()).toContain('重新登录')
})

test('the resolve endpoint rejects anonymous and read-only operators', async ({ page }) => {
  const payload = {
    headers,
    data: {
      id: 'missing',
      outcome: 'failed',
      note: '核对',
      confirmed: true,
      expectedRevision: '0'.repeat(64),
    },
  }
  expect((await page.request.post('/api/admin/orders/resolve', payload)).status()).toBe(401)
  const email = `readonly-${id()}@example.com`
  await login(page.request, email)
  const reader = await db.user.findUniqueOrThrow({ where: { email } })
  const role = await db.role.create({
    data: { id: id(), name: '订单只读', permissions: ['admin:access', 'orders:read'] },
  })
  await db.userRole.create({ data: { userId: reader.id, roleId: role.id } })
  const response = await page.request.post('/api/admin/orders/resolve', payload)
  expect(response.status()).toBe(403)
  expect(await response.text()).toContain('没有此操作权限')
  await page.goto('/admin')
  await openAdminPage(page, '订单管理')
  await expect(page.getByRole('button', { name: '人工处理', exact: true })).toHaveCount(0)
})
