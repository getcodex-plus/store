import { expect, type Page } from '@playwright/test'

export async function openAdminPage(page: Page, label: string) {
  const group = (
    {
      商品管理: '商品与兑换',
      兑换码管理: '商品与兑换',
      导入批次: '商品与兑换',
      订单管理: '商品与兑换',
      用户钱包: '资金与返现',
      邀请与返现: '资金与返现',
      提现审核: '资金与返现',
      用户管理: '用户与权限',
      角色与权限: '用户与权限',
      支付与服务: '系统管理',
      网站设置: '系统管理',
      操作日志: '系统管理',
      风控记录: '系统管理',
    } as Record<string, string>
  )[label]
  const item = page.getByRole('menuitem', { name: label, exact: true })
  if (group) {
    const parent = page.getByRole('menuitem', { name: new RegExp(`${group}$`) })
    await expect(parent).toBeVisible()
    if (!(await item.isVisible())) await parent.click()
  }
  await item.click()
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
}
