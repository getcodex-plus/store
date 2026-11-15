import { expect, test, type APIRequestContext } from '@playwright/test'
import { db } from '../src/server/db'
import { demoSession } from '../src/lib'
import { openAdminPage } from './admin-helpers'

const origin = process.env.E2E_BASE_URL || 'http://localhost:3000'
const headers = { Origin: origin, 'X-GetGPT-Request': '1' }

async function login(request: APIRequestContext, email: string) {
  expect((await request.get('/api/bootstrap')).ok()).toBe(true)
  expect(
    (
      await request.post('/api/auth/email-otp/send-verification-otp', {
        headers,
        data: { email, type: 'sign-in' },
      })
    ).ok(),
  ).toBe(true)
  const code = await request.post('/api/demo/code', { headers, data: { email } })
  expect(code.ok()).toBe(true)
  expect(
    (
      await request.post('/api/auth/sign-in/email-otp', {
        headers,
        data: { email, otp: (await code.json()).demoCode },
      })
    ).ok(),
  ).toBe(true)
  expect((await request.get('/api/account')).status()).toBe(200)
}

test.afterAll(async () => {
  await db.$disconnect()
})

test('security page revokes other sessions while keeping this session and other users signed in', async ({
  page,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: origin })
  const unrelated = await browser.newContext({ baseURL: origin })
  try {
    const email = `sessions-${crypto.randomUUID()}@example.com`
    await login(page.request, email)
    await login(other.request, email)
    await login(unrelated.request, `unrelated-${crypto.randomUUID()}@example.com`)
    await page.goto('/security')
    const revoke = page.getByRole('main').getByRole('button', { name: '退出其他设备', exact: true })
    await revoke.click()
    const confirm = page.getByRole('tooltip')
    await confirm.getByRole('button', { name: /取\s*消/ }).click()
    await expect(confirm).toBeHidden()
    expect((await other.request.get('/api/account')).status()).toBe(200)
    await revoke.click()
    await confirm.getByRole('button', { name: '退出其他设备', exact: true }).click()
    await expect(page.getByText('其他登录会话已退出，当前会话已保留')).toBeVisible()
    expect((await page.request.get('/api/account')).status()).toBe(200)
    expect((await other.request.get('/api/account')).status()).toBe(401)
    expect((await unrelated.request.get('/api/account')).status()).toBe(200)
  } finally {
    await other.close()
    await unrelated.close()
  }
})

test('order API snapshots gateway IPs and exposes them only through admin order records', async ({
  page,
  browser,
}) => {
  await login(page.request, 'admin@example.com')
  const input = {
    amount: 1000,
    channel: 'alipay',
    requestKey: crypto.randomUUID(),
    ipAddress: '198.51.100.99',
  }
  const created = await page.request.post('/api/orders', {
    headers: { ...headers, 'X-Forwarded-For': '192.0.2.41' },
    data: input,
  })
  expect(created.ok()).toBe(true)
  const order = await created.json()
  expect(order).not.toHaveProperty('ipAddress')
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).ipAddress).toBe(
    '192.0.2.41',
  )
  const retried = await page.request.post('/api/orders', {
    headers: { ...headers, 'X-Forwarded-For': '192.0.2.42' },
    data: input,
  })
  expect(retried.ok()).toBe(true)
  expect((await retried.json()).id).toBe(order.id)
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).ipAddress).toBe(
    '192.0.2.41',
  )
  const publicOrder = await page.request.get(`/api/orders/${order.id}`)
  expect(publicOrder.ok()).toBe(true)
  expect(await publicOrder.json()).not.toHaveProperty('ipAddress')
  await page.goto('/admin')
  await openAdminPage(page, '订单管理')
  await page.getByLabel('搜索订单、联系邮箱、充值账号、套餐或 IP').fill('192.0.2.41')
  const row = page.getByRole('row').filter({ hasText: order.id })
  await expect(row).toContainText('192.0.2.41')

  const guest = await browser.newContext({ baseURL: origin })
  try {
    await guest.request.get('/api/bootstrap')
    const quote = await guest.request.post('/api/quotes', {
      headers,
      data: { productId: 'plus', session: demoSession(`guest-${crypto.randomUUID()}@example.com`) },
    })
    expect(quote.ok()).toBe(true)
    const purchase = await guest.request.post('/api/orders', {
      headers: { ...headers, 'X-Forwarded-For': '2001:db8:1234:5678:abcd::1' },
      data: {
        quoteId: (await quote.json()).id,
        channel: 'alipay',
        requestKey: crypto.randomUUID(),
        contactEmail: `contact-${crypto.randomUUID()}@example.com`,
      },
    })
    expect(purchase.ok()).toBe(true)
    const guestOrder = await purchase.json()
    expect(guestOrder).not.toHaveProperty('ipAddress')
    expect((await db.order.findUniqueOrThrow({ where: { id: guestOrder.id } })).ipAddress).toBe(
      '2001:0db8:1234:5678:abcd:0000:0000:0001',
    )
    expect((await guest.request.get('/api/admin?section=orders')).status()).toBe(401)
  } finally {
    await guest.close()
  }
})
