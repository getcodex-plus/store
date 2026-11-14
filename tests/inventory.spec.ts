import { expect, test } from '@playwright/test'
import { openAdminPage } from './admin-helpers'

test('CSV batches supply independently and keep editable notes without exposing codes', async ({
  page,
}) => {
  await page.goto('/')
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
  await page.goto('/admin')
  await openAdminPage(page, '导入批次')
  const token = Date.now()
  const codes = [`csv-code-${token}-0001`, `csv-code-${token}-0002`]
  const firstName = `TR-${token}`
  await page.getByRole('button', { name: '导入兑换库存' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: '绑定商品' }).click()
  await page.getByTitle('ChatGPT Plus', { exact: true }).click()
  await expect(dialog.getByLabel('AICDK 商品', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('国家 / 地区')).toHaveCount(0)
  await dialog.getByLabel('批次备注').fill('土耳其第一批，采购成本较低')
  await dialog.getByText('File', { exact: true }).click()
  const uploads: string[] = []
  const observeUploads = (request: import('@playwright/test').Request) => {
    if (
      request.method() === 'POST' &&
      (request.url().includes('/admin/inventory') ||
        request.headers()['content-type']?.includes('multipart/form-data'))
    )
      uploads.push(request.url())
  }
  page.on('request', observeUploads)
  await dialog.getByLabel('选择 CSV 文件').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('wrong_header\ninvalid-code'),
  })
  await expect(dialog.getByRole('alert')).toContainText('单列 code')
  const csv = {
    name: `${firstName}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(`\uFEFFcode\r\n"${codes[0]}"\r\n"${codes[1]}"\r\n"${codes[1]}"\r\n`),
  }
  await dialog.getByLabel('选择 CSV 文件').setInputFiles(csv)
  await expect(dialog.getByLabel('批次名称')).toHaveValue(firstName)
  await expect(dialog).toContainText('已识别 3 个兑换码')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '更换文件' })).toBeVisible()
  await dialog.getByRole('button', { name: '移除文件' }).click()
  await expect(dialog).not.toContainText('已识别 3 个兑换码')
  await dialog.getByLabel('选择 CSV 文件').setInputFiles(csv)
  await expect(dialog).toContainText('已识别 3 个兑换码')
  expect(uploads).toEqual([])
  page.off('request', observeUploads)
  await dialog.getByRole('button', { name: '加密保存库存' }).click()
  await expect(dialog).toBeHidden()
  const first = page.getByRole('row').filter({ hasText: firstName })
  await expect(first).toContainText('新增 2')
  await expect(first).toContainText('重复 1')
  await expect(first).toContainText('土耳其第一批')
  await expect(first.getByRole('switch')).toBeChecked()
  await first.getByRole('button', { name: '编辑备注' }).click()
  await expect(dialog.getByLabel('批次名称')).toHaveValue(firstName)
  await dialog.getByLabel('批次备注').fill('已核实：较低成本国家')
  await dialog.getByRole('button', { name: '保存批次' }).click()
  await expect(dialog).toBeHidden()
  await expect(first).toContainText('已核实：较低成本国家')
  await first.getByRole('button', { name: '编辑备注' }).click()
  await expect(dialog.getByLabel('批次名称')).toHaveValue(firstName)
  await expect(dialog.getByLabel('批次备注')).toHaveValue('已核实：较低成本国家')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const origin = process.env.E2E_BASE_URL || 'http://localhost:3000'
  const secondName = `TR-second-${token}`
  const response = await page.request.post('/api/admin/inventory', {
    headers: { Origin: origin, 'X-GetGPT-Request': '1' },
    data: {
      productId: 'plus',
      codes: [`csv-second-${token}`],
      batchName: secondName,
      enabled: false,
    },
  })
  expect(response.ok()).toBe(true)
  await page.getByRole('button', { name: /刷新$/ }).click()
  const second = page.getByRole('row').filter({ hasText: secondName })
  await expect(second.getByRole('switch')).not.toBeChecked()
  await second.getByRole('switch').click()
  await expect(second.getByRole('switch')).toBeChecked()
  await expect(first.getByRole('switch')).toBeChecked()
  await first.getByRole('switch').click()
  await expect(first.getByRole('switch')).not.toBeChecked()
  await expect(second.getByRole('switch')).toBeChecked()
  await first.getByRole('switch').click()
  await expect(first.getByRole('switch')).toBeChecked()
  await expect(second.getByRole('switch')).toBeChecked()
  await first.getByRole('button', { name: '查看兑换码' }).click()
  await expect(page.getByRole('heading', { name: '兑换码管理' })).toBeVisible()
  await expect(page.getByText('•••• 0001', { exact: true })).toBeVisible()
  const codeRow = page.getByRole('row').filter({ hasText: '•••• 0001' })
  await codeRow.getByRole('button', { name: '更换', exact: true }).click()
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog).toContainText('通过 AICDK 生成新兑换码')
  await expect(dialog.getByRole('button', { name: '确认更换' })).toBeVisible()
  await dialog.locator('.ant-modal-close').click()
  await expect(page.getByText('已使用（Used）', { exact: false }).first()).toBeVisible()
  const listResponse = await page.request.get('/api/admin/inventory')
  const body = await listResponse.text()
  for (const code of codes) expect(body).not.toContain(code)
  expect(body).not.toContain('fingerprint')
  await page.reload()
  await expect(page.getByRole('heading', { name: '兑换码管理' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开导航' }).click()
  const drawer = page.getByRole('dialog')
  await drawer.getByRole('menuitem', { name: '导入批次', exact: true }).click()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { name: '导入批次', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
