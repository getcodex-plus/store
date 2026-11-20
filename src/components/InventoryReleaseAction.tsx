'use client'
import { App, Button, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { InventoryReleaseRound } from '../inventory-types'
import { api } from '../lib'

export function InventoryReleaseAction({
  orderId,
  entry,
  canManage,
  maskedCode,
  showRound = false,
  onRefresh,
}: {
  orderId: string
  entry: InventoryReleaseRound
  canManage: boolean
  maskedCode?: string
  showRound?: boolean
  onRefresh: () => Promise<void>
}) {
  const { modal, message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const round = entry.round ? `补充第 ${entry.round} 轮` : '首次兑换'
  const prefix = showRound ? `${round} · ` : ''
  if (entry.state === 'awaiting_refund')
    return <span className="muted">{prefix}退款完成后可手动释放</span>
  if (entry.state === 'completed') return <Tag color="success">{prefix}已置换入库</Tag>
  if (entry.state === 'review')
    return (
      <div>
        <Tag color="warning">{prefix}请到 AICDK 核对</Tag>
        <div>旧卡已锁定，新卡未入库。</div>
        <div className="tiny muted admin-record-id">
          {entry.upstreamCodeId ? '上游新码编号：' : '本站库存编号：'}
          <Typography.Text copyable>{entry.upstreamCodeId ?? entry.inventoryId}</Typography.Text>
        </div>
      </div>
    )
  const pending = entry.state === 'pending'
  if (!canManage || (pending && !entry.canReconcile))
    return (
      <Tag>
        {prefix}
        {pending ? '释放结果待核对，旧卡已锁定' : '未释放'}
      </Tag>
    )
  const label = pending ? '核对释放结果' : '手动释放卡密'
  function confirm() {
    modal.confirm({
      title: pending ? '核对原置换请求？' : '置换这张卡密并释放库存？',
      content: (
        <div>
          <p>
            订单：{orderId}（{round}）
          </p>
          {maskedCode && <p>原卡：{maskedCode}</p>}
          <p>
            {pending
              ? '使用同一次请求核对，不会再次换码。'
              : '订单已退款。系统将核对上游兑换结果；置换成功后旧码永久停用，只有新码入库。'}
          </p>
        </div>
      ),
      okText: pending ? '核对原请求' : '确认置换并释放',
      cancelText: '取消',
      focusable: { autoFocusButton: pending ? 'ok' : 'cancel' },
      async onOk() {
        setBusy(true)
        try {
          await api('/admin/orders/release-inventory', {
            id: orderId,
            round: entry.round,
            inventoryId: entry.inventoryId,
            confirmed: true,
            ...(pending && { reconcile: true }),
          })
          message.success('旧码已停用，新卡密已入库')
        } catch (error) {
          message.error((error as Error).message)
        } finally {
          setBusy(false)
          await onRefresh()
        }
      },
    })
  }
  return (
    <Button type="link" loading={busy} onClick={confirm}>
      {prefix}
      {label}
    </Button>
  )
}
