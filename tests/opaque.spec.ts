import { expect, test, type Page } from '@playwright/test'
import { URI } from 'otpauth'
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

async function createPasswordAccount(page: Page, email: string, password: string) {
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await enterEmailCode(page)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.goto('/security')
  await page.getByLabel('新密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByText('密码已更新，其他登录会话已注销')).toBeVisible()
}

async function enterEmailCode(page: Page) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '获取验证码', exact: true }).click()
  const alert = dialog.getByText(/本地演示验证码：/)
  await expect(alert).toBeVisible()
  const code = (await alert.textContent())!.match(/\d{6}/)![0]
  await dialog.getByPlaceholder('6 位验证码', { exact: true }).fill(code)
  return code
}

async function startRecovery(page: Page, email: string) {
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByRole('tab', { name: '密码登录' }).click()
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('邮箱地址')).toHaveValue(email)
  await expect(dialog.getByLabel('密码', { exact: true })).toHaveCount(0)
  return dialog
}

test('forgotten password recovery verifies email, replaces the OPAQUE record and signs out every device', async ({
  page,
  browser,
}) => {
  const email = `recovery-ui-${crypto.randomUUID()}@example.com`
  const original = `original-${crypto.randomUUID()}`
  const replacement = `replacement-${crypto.randomUUID()}`
  const headers = { Origin: origin }
  await createPasswordAccount(page, email, original)
  const other = await browser.newContext({ baseURL: origin })
  expect((await opaqueLogin(other.request, email, original, headers)).ok()).toBe(true)
  await page.request.post('/api/auth/sign-out', { headers, data: {} })
  const bodies: string[] = []
  const resetPaths: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      bodies.push(request.postData() || '')
      if (request.url().includes('/opaque/resetPassword/')) resetPaths.push(request.url())
    }
  })
  const dialog = await startRecovery(page, email)
  const code = await enterEmailCode(page)
  const wrongCode = `${(Number(code[0]) + 1) % 10}${code.slice(1)}`
  await dialog.getByPlaceholder('6 位验证码', { exact: true }).fill(wrongCode)
  await dialog.getByRole('button', { name: '验证身份并继续' }).click()
  await expect(dialog.getByLabel('新密码', { exact: true })).toHaveCount(0)
  await dialog.getByPlaceholder('6 位验证码', { exact: true }).fill(code)
  await dialog.getByRole('button', { name: '验证身份并继续' }).click()
  await expect(dialog.getByLabel('新密码', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(`正在为 ${email} 设置新密码，无需输入旧密码。`)).toBeVisible()
  await dialog.getByLabel('新密码', { exact: true }).fill('too-short')
  await dialog.getByLabel('确认密码', { exact: true }).fill('too-short')
  await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(dialog.getByText('密码长度为 12–128 个字符')).toBeVisible()
  expect(resetPaths).toHaveLength(0)
  await dialog.getByLabel('新密码', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(dialog.getByText('两次密码不一致')).toBeVisible()
  expect(resetPaths).toHaveLength(0)
  await dialog.getByLabel('确认密码', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('密码已重置，所有会话已注销，请使用新密码重新登录')).toBeVisible()
  expect((await page.request.get('/api/account')).status()).toBe(401)
  expect((await other.request.get('/api/account')).status()).toBe(401)
  expect(resetPaths).toHaveLength(2)
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByRole('tab', { name: '密码登录' }).click()
  await dialog.getByLabel('邮箱地址').fill(email)
  await dialog.getByLabel('密码', { exact: true }).fill(original)
  await dialog.getByRole('button', { name: /登录 \/ 注册/ }).click()
  await expect(page.getByText('邮箱或密码不正确', { exact: true })).toBeVisible()
  await dialog.getByLabel('密码', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: /登录 \/ 注册/ }).click()
  await expect(dialog).toBeHidden()
  expect((await page.request.get('/api/account')).status()).toBe(200)
  for (const body of bodies) {
    expect(body).not.toContain(original)
    expect(body).not.toContain(replacement)
    expect(body).not.toContain('"currentPassword"')
    expect(body).not.toContain('"newPassword"')
    expect(body).not.toContain('"clientRegistrationState"')
  }
  await other.close()
})

test('recovery honors TOTP and retains two-step verification after resetting the password', async ({
  page,
}) => {
  const email = `recovery-mfa-${crypto.randomUUID()}@example.com`
  const original = `original-${crypto.randomUUID()}`
  const replacement = `replacement-${crypto.randomUUID()}`
  const headers = { Origin: origin }
  await createPasswordAccount(page, email, original)
  expect(
    (
      await page.request.post('/api/auth/two-factor/enable', { headers, data: { method: 'otp' } })
    ).ok(),
  ).toBe(true)
  const setup = await page.request.post('/api/auth/two-factor/enable', { headers, data: {} })
  const totp = URI.parse((await setup.json()).totpURI)
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-totp', {
        headers,
        data: { code: totp.generate() },
      })
    ).ok(),
  ).toBe(true)
  await page.request.post('/api/auth/sign-out', { headers, data: {} })
  const dialog = await startRecovery(page, email)
  await enterEmailCode(page)
  await dialog.getByRole('button', { name: '验证身份并继续' }).click()
  await expect(dialog.getByLabel('TOTP 动态验证码')).toBeVisible()
  await expect(dialog.getByLabel('新密码', { exact: true })).toHaveCount(0)
  expect(
    (
      await page.request.post('/api/auth/opaque/resetPassword/challenge', { headers, data: {} })
    ).status(),
  ).toBe(403)
  await dialog.getByLabel('TOTP 动态验证码').fill(totp.generate())
  await dialog.getByRole('button', { name: '完成二步验证' }).click()
  await dialog.getByLabel('新密码', { exact: true }).fill(replacement)
  await dialog.getByLabel('确认密码', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(dialog).toBeHidden()
  const login = await opaqueLogin(page.request, email, replacement, headers)
  expect(await login.json()).toMatchObject({ twoFactorRedirect: true })
  expect((await page.request.get('/api/account')).status()).toBe(401)
  expect(
    (
      await page.request.post('/api/auth/two-factor/verify-totp', {
        headers,
        data: { code: totp.generate() },
      })
    ).ok(),
  ).toBe(true)
  expect(await (await page.request.get('/api/security')).json()).toMatchObject({
    totp: true,
    twoStepEnabled: true,
  })
})

test('account security can recover with a Passkey while keeping that Passkey and MFA enabled', async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page)
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
  const email = `recovery-passkey-${crypto.randomUUID()}@example.com`
  const replacement = `replacement-${crypto.randomUUID()}`
  await createPasswordAccount(page, email, `original-${crypto.randomUUID()}`)
  await page.getByRole('button', { name: '添加 Passkey' }).click()
  await expect(page.getByText('Passkey 已添加，密码登录将需要二步验证')).toBeVisible()
  await page.getByRole('button', { name: '验证身份并重置密码' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('邮箱地址')).toHaveValue(email)
  await dialog.getByRole('button', { name: '使用 Passkey 登录' }).click()
  await dialog.getByLabel('新密码', { exact: true }).fill(replacement)
  await dialog.getByLabel('确认密码', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect((await page.request.get('/api/account')).status()).toBe(401)
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await dialog.getByRole('button', { name: '使用 Passkey 登录' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('switch', { name: '二步验证', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: '二步验证', exact: true })).toBeDisabled()
  expect((await (await page.request.get('/api/security')).json()).passkeys).toHaveLength(1)
})
