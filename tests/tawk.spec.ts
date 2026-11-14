import { expect, test, type Page } from '@playwright/test'
import { db, type Prisma } from '../src/server/db'
import { jsonInput, settingsData } from '../src/server/data'
import { openAdminPage } from './admin-helpers'

const config = {
  enabled: true,
  propertyId: '0123456789abcdef01234567',
  widgetId: 'default',
}
const embed = `https://embed.tawk.to/${config.propertyId}/${config.widgetId}`
const scriptSelector = 'script[src^="https://embed.tawk.to/"]'
let original: Prisma.JsonValue

async function saveConfig(enabled: boolean) {
  await db.setting.update({
    where: { id: 1 },
    data: { body: jsonInput({ ...settingsData(original), tawk: { ...config, enabled } }) },
  })
}

async function loginAdmin(page: Page) {
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
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
}

test.beforeAll(async () => {
  original = (await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body
})

test.beforeEach(async ({ page }) => {
  await saveConfig(false)
  await page.route('https://www.googletagmanager.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  )
})

test.afterEach(async () => {
  await db.setting.update({ where: { id: 1 }, data: { body: jsonInput(settingsData(original)) } })
})

test.afterAll(async () => {
  await db.$disconnect()
})

test('saves dashboard configuration, loads once across routes, and disables on reload', async ({
  page,
  baseURL,
}) => {
  let requests = 0
  await page.route('https://*.tawk.to/**', async (route) => {
    if (route.request().url() === embed) {
      requests++
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.__tawkConfigAtLoad = JSON.parse(JSON.stringify(window.Tawk_API));
          window.__tawkStarted = window.Tawk_LoadStart instanceof Date;
          fetch('https://va.tawk.to/test-init')
            .then(() => { window.__tawkConnected = true; });
        `,
      })
    } else {
      await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, body: '{}' })
    }
  })
  await page.goto('/')
  await loginAdmin(page)
  expect(requests).toBe(0)
  await expect(page.locator(scriptSelector)).toHaveCount(0)
  await page.goto('/admin')
  await openAdminPage(page, '网站设置')
  await page.getByLabel('Tawk.to 在线客服', { exact: true }).click()
  await page.getByLabel('Tawk.to Property ID', { exact: true }).fill('invalid')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByText('请输入 24 位小写十六进制 Property ID')).toBeVisible()
  await page.getByLabel('Tawk.to Property ID', { exact: true }).fill(config.propertyId)
  await page.getByLabel('Tawk.to Widget ID', { exact: true }).fill(config.widgetId)
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  expect(
    settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).tawk,
  ).toEqual(config)
  expect(requests).toBe(0)

  // The server also rejects unsafe values even if form validation is bypassed.
  const response = await page.request.get('/api/admin')
  const current = (await response.json()).settings
  const rejected = await page.request.post('/api/admin/settings', {
    headers: { origin: new URL(baseURL!).origin, 'X-GetGPT-Request': '1' },
    data: { ...current, tawk: { ...config, widgetId: '../untrusted' } },
  })
  expect(rejected.status()).toBe(400)
  const { tawk: _tawk, ...legacySettings } = current
  const legacySave = await page.request.post('/api/admin/settings', {
    headers: { origin: new URL(baseURL!).origin, 'X-GetGPT-Request': '1' },
    data: legacySettings,
  })
  expect(legacySave.ok()).toBe(true)
  expect(
    settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).tawk,
  ).toEqual(config)

  const documentResponse = await page.reload()
  await expect.poll(() => page.evaluate(() => (window as any).__tawkConnected)).toBe(true)
  const nonce = await page
    .locator(scriptSelector)
    .evaluate((script) => (script as HTMLScriptElement).nonce)
  expect(nonce).not.toBe('')
  expect(documentResponse?.headers()['content-security-policy']).toContain(`'nonce-${nonce}'`)
  const initialization = await page.evaluate(() => ({
    api: (window as any).__tawkConfigAtLoad,
    started: (window as any).__tawkStarted,
  }))
  expect(initialization).toEqual({
    api: {
      customStyle: {
        zIndex: 900,
        visibility: {
          desktop: { position: 'br', xOffset: 24, yOffset: 24 },
          mobile: { position: 'br', xOffset: 16, yOffset: 24 },
        },
      },
    },
    started: true,
  })

  await page.getByRole('link', { name: /返回网站/ }).click()
  await expect(page).toHaveURL('/')
  await page.locator('a[href^="/checkout?product="]').first().click()
  await expect(page.getByLabel('账号会话信息', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('账号会话信息', { exact: true }).fill('synthetic-private-session')
  await expect(page.locator(scriptSelector)).toHaveCount(1)
  expect(requests).toBe(1)
  expect(JSON.stringify(initialization)).not.toContain('admin@example.com')

  await saveConfig(false)
  await page.reload()
  await expect(page.getByLabel('账号会话信息', { exact: true })).toBeVisible()
  await expect(page.locator(scriptSelector)).toHaveCount(0)
  expect(requests).toBe(1)
})

test('keeps checkout usable and the support email available when the widget fails to load', async ({
  page,
}) => {
  await saveConfig(true)
  let attempted = false
  await page.route('https://*.tawk.to/**', async (route) => {
    attempted = true
    await route.abort('failed')
  })
  await page.goto('/checkout?product=plus')
  await expect.poll(() => attempted).toBe(true)
  const session = page.getByLabel('账号会话信息', { exact: true })
  await session.fill('synthetic-private-session')
  await expect(session).toHaveValue('synthetic-private-session')
  await expect(page.locator('footer a[href="mailto:support@example.com"]')).toBeVisible()
})
