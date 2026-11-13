import { expect, test } from '@playwright/test'
import { opaqueLogin } from './opaque-helpers'

const origin = process.env.E2E_BASE_URL || 'http://localhost:3000'

test('OPAQUE setup, login and change keep plaintext passwords out of browser requests', async ({
  page,
  browser,
}) => {
  const email = `opaque-ui-${crypto.randomUUID()}@example.com`
  const original = `opaque-original-${crypto.randomUUID()}`
  const replacement = `opaque-replacement-${crypto.randomUUID()}`
  const requests: { path: string; body: string }[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.method() === 'POST')
      requests.push({ path: new URL(request.url()).pathname, body: request.postData() || '' })
  })
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill(email)
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
  await page.goto('/security')
  await page.getByLabel('新密码', { exact: true }).fill(original)
  await page.getByLabel('确认密码', { exact: true }).fill(original)
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByText('密码已更新，其他登录会话已注销')).toBeVisible()
  await expect(page.getByLabel('新密码', { exact: true })).toHaveValue('')

  const other = await browser.newContext({ baseURL: origin })
  const headers = { Origin: origin }
  expect((await opaqueLogin(other.request, email, original, headers)).ok()).toBe(true)
  expect((await other.request.get('/api/account')).status()).toBe(200)

  await page.getByLabel('当前密码', { exact: true }).fill('incorrect')
  await page.getByLabel('新密码', { exact: true }).fill(replacement)
  await page.getByLabel('确认密码', { exact: true }).fill(replacement)
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByText('当前密码不正确', { exact: true })).toBeVisible()
  await page.getByLabel('当前密码', { exact: true }).fill(original)
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByLabel('新密码', { exact: true })).toHaveValue('')
  expect((await other.request.get('/api/account')).status()).toBe(401)
  await other.close()

  await page.request.post('/api/auth/sign-out', { headers, data: {} })
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByRole('tab', { name: '密码登录' }).click()
  await page.getByPlaceholder('you@example.com').fill(email.toUpperCase())
  await page.getByLabel('密码', { exact: true }).fill(original)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByText('邮箱或密码不正确', { exact: true })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(replacement)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect((await page.request.get('/api/account')).status()).toBe(200)
  expect(errors).toEqual([])
  expect(requests.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      '/api/auth/opaque/enroll/complete',
      '/api/auth/opaque/changePassword/complete',
      '/api/auth/sign-in/opaque/complete',
    ]),
  )
  for (const { body } of requests) {
    expect(body).not.toContain(original)
    expect(body).not.toContain(replacement)
    expect(body).not.toContain('"currentPassword"')
    expect(body).not.toContain('"password"')
    expect(body).not.toContain('"clientLoginState"')
    expect(body).not.toContain('"clientRegistrationState"')
  }
})
