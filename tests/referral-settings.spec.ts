import { expect, test } from '@playwright/test'
import { db, type Prisma } from '../src/server/db'
import { jsonInput, settingsData } from '../src/server/data'
import { defaultReferralTiers } from '../src/referral'
import { openAdminPage } from './admin-helpers'

let original: Prisma.JsonValue

test.beforeAll(async () => {
  original = (await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body
  await db.setting.update({
    where: { id: 1 },
    data: {
      body: jsonInput({
        ...settingsData(original),
        referralTiers: defaultReferralTiers,
        rateBps: defaultReferralTiers[0].rateBps,
      }),
    },
  })
})

test.afterAll(async () => {
  try {
    await db.setting.update({
      where: { id: 1 },
      data: { body: jsonInput(settingsData(original)) },
    })
  } finally {
    await db.$disconnect()
  }
})

test('configures arbitrary tiers, validates rules, preserves failed edits and persists a single tier', async ({
  page,
  baseURL,
}) => {
  await page.goto('/admin')
  await page.getByRole('button', { name: '管理员登录' }).click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const code = page.getByText(/本地演示验证码：/)
  await expect(code).toBeVisible()
  await page.getByLabel('登录验证码').fill((await code.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await openAdminPage(page, '网站设置')

  const save = page.getByRole('button', { name: '保存设置', exact: true })
  await page.getByRole('button', { name: '新增返利等级' }).click()
  await page.getByLabel('等级 5 名称', { exact: true }).fill('城市合伙人')
  await page.getByLabel('等级 5 有效邀请（人）', { exact: true }).fill('50')
  await page.getByLabel('等级 5 返现（%）', { exact: true }).fill('7.25')
  await save.click()
  await expect(page.getByText('各等级人数门槛必须逐级提高', { exact: true })).toBeVisible()
  await page.getByLabel('等级 5 有效邀请（人）', { exact: true }).fill('100')
  await page.getByLabel('等级 5 返现（%）', { exact: true }).fill('5')
  await save.click()
  await expect(page.getByText('高等级返现比例不能低于前一级', { exact: true })).toBeVisible()
  await page.getByLabel('等级 5 返现（%）', { exact: true }).fill('7.25')

  await page.route('**/api/admin/settings', (route) =>
    route.fulfill({ status: 500, json: { error: '测试保存失败，请重试' } }),
  )
  await save.click()
  await expect(page.getByText('测试保存失败，请重试', { exact: true })).toBeVisible()
  await expect(page.getByLabel('等级 5 名称', { exact: true })).toHaveValue('城市合伙人')
  await page.unroute('**/api/admin/settings')
  await save.click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  const saved = settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)
  expect(saved.referralTiers).toHaveLength(5)
  expect(saved.referralTiers![4]).toMatchObject({
    name: '城市合伙人',
    minimumInvites: 100,
    rateBps: 725,
  })
  const customId = saved.referralTiers![4].id
  expect(customId).toMatch(/^[a-z\d_-]{1,32}$/)
  await page.reload()
  await expect(page.getByLabel('等级 5 名称', { exact: true })).toHaveValue('城市合伙人')

  // API validation must also protect direct callers.
  for (const referralTiers of [
    [],
    [{ ...saved.referralTiers![0], minimumInvites: 1 }],
    [{ ...saved.referralTiers![0], rateBps: 901 }],
  ]) {
    const rejected = await page.request.post('/api/admin/settings', {
      headers: { origin: new URL(baseURL!).origin, 'X-GetGPT-Request': '1' },
      data: { ...saved, referralTiers },
    })
    expect(rejected.status()).toBe(400)
  }
  expect(settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)).toEqual(
    saved,
  )

  await page.getByRole('button', { name: '删除等级 3', exact: true }).click()
  await expect(page.getByLabel('等级 3 名称', { exact: true })).toHaveValue('邀请合伙人')
  for (let remaining = 4; remaining > 1; remaining--)
    await page.getByRole('button', { name: '删除等级 1', exact: true }).click()
  await expect(page.getByLabel('等级 1 名称', { exact: true })).toHaveValue('城市合伙人')
  await expect(page.getByLabel('等级 1 有效邀请（人）', { exact: true })).toHaveValue('0')
  await expect(page.getByRole('button', { name: '删除等级 1', exact: true })).toBeDisabled()
  await page.getByLabel('等级 1 名称', { exact: true }).fill('统一返利')
  await save.click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  const single = settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body)
  expect(single.referralTiers).toEqual([
    { id: customId, name: '统一返利', minimumInvites: 0, rateBps: 725 },
  ])
  expect(single.rateBps).toBe(725)
  await page.reload()
  await expect(page.getByLabel('等级 1 名称', { exact: true })).toHaveValue('统一返利')
  await expect(page.getByRole('button', { name: /^删除等级/ })).toHaveCount(1)
  await page.goto('/referral')
  await expect(page.getByText('统一返利 · 邀请奖励 7.25%', { exact: true })).toBeVisible()
  await expect(page.locator('.referral-level-list > li')).toHaveCount(1)

  const bootstrap = await (await page.request.get('/api/bootstrap')).json()
  bootstrap.user.permissions = bootstrap.user.permissions.filter(
    (permission: string) => permission !== 'settings:write',
  )
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: bootstrap }))
  await page.goto('/admin#settings')
  await expect(page.getByLabel('等级 1 名称', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '新增返利等级' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '删除等级 1', exact: true })).toBeDisabled()
})
