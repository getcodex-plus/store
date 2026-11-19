'use client'
import { useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, Modal, Radio, Tag } from 'antd'
import type { AdminOrder } from '../types'
import { api, dateTime, money, orderStatusLabel } from '../lib'
import { canResolveOrder } from '../order-resolution'

export function OrderResolutionDialog({
  order,
  canWrite,
  onClose,
  onRefresh,
}: {
  order: AdminOrder
  canWrite: boolean
  onClose: () => void
  onRefresh: () => Promise<void>
}) {
  const { message } = App.useApp()
  const [outcome, setOutcome] = useState<'completed' | 'failed'>()
  const [note, setNote] = useState('')
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resolution = order.fulfillmentResolution
  const editable = canWrite && !resolution && canResolveOrder(order)
  const confirmed = reviewedRevision === order.resolutionRevision
  const status = orderStatusLabel(order)

  async function submit() {
    if (busy || !editable || !outcome || !note.trim() || !confirmed) return
    setBusy(true)
    setError('')
    try {
      await api('/admin/orders/resolve', {
        id: order.id,
        outcome,
        note,
        expectedRevision: order.resolutionRevision,
        confirmed,
      })
      message.success(
        outcome === 'completed' ? '已确认兑换成功' : '已确认兑换失败，未退款或发起补充',
      )
      await onRefresh()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setReviewedRevision(null)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={resolution ? '人工处理记录' : '人工处理兑换'}
      open
      width={600}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {editable ? '取消' : '关闭'}
          </Button>
          {editable && (
            <Button
              type="primary"
              danger={outcome === 'failed'}
              loading={busy}
              disabled={!outcome || !note.trim() || !confirmed}
              onClick={submit}
            >
              {outcome === 'completed'
                ? '确认兑换成功'
                : outcome === 'failed'
                  ? '确认兑换失败'
                  : '登记处理结果'}
            </Button>
          )}
        </>
      }
    >
      <div className="refund-summary">
        <div>
          <strong>
            {order.productName} · {money(order.amount)}
          </strong>
          <Tag color={status.color}>{status.text}</Tag>
        </div>
        <span className="tiny muted mono">{order.id}</span>
        <span>充值账号：{order.email}</span>
      </div>
      {error && <Alert className="mb-24" type="error" showIcon title={error} />}
      {resolution ? (
        <>
          {resolution.conflict && (
            <Alert
              className="mb-24"
              type="error"
              showIcon
              title="上游结果与人工结论冲突，待核对"
              description={`上游后续反馈兑换${resolution.conflict.status === 'completed' ? '成功' : '失败或取消'}，发现时间 ${dateTime(resolution.conflict.detectedAt)}。请核对上游兑换记录和账号实际结果，处理前不要退款或重新兑换。`}
            />
          )}
          <div className="refund-record">
            <p>处理结果：{resolution.outcome === 'completed' ? '已核实成功' : '已核实失败'}</p>
            <p>
              操作人：{resolution.actor} · {dateTime(resolution.createdAt)}
            </p>
            <p>
              处理前状态：
              {resolution.previousStatus === 'needs_session' ? '需更新账号信息' : '充值中'}
              {resolution.previousFulfillmentStatus === 'uncertain' ? '（结果不确定）' : ''}
              {resolution.previousFulfillmentStatus === 'requires_action'
                ? '（需要进一步处理）'
                : ''}
            </p>
            <p className="refund-note">核对依据：{resolution.note}</p>
            {resolution.conflict && (
              <p className="refund-note">上游兑换号：{resolution.conflict.redemptionId}</p>
            )}
          </div>
        </>
      ) : editable ? (
        <>
          <Alert
            className="mb-24"
            type="warning"
            showIcon
            title="请先核对上游记录和账号实际结果"
            description="登记后停止自动兑换同步，并保留处理记录。确认失败前，请确保上游不会继续执行原兑换。"
          />
          <Form layout="vertical" onFinish={submit}>
            <Form.Item label="核对结果" required>
              <Radio.Group
                aria-label="核对结果"
                value={outcome}
                disabled={busy}
                onChange={(e) => {
                  setOutcome(e.target.value)
                  setReviewedRevision(null)
                }}
              >
                <Radio value="completed">已核实成功</Radio>
                <Radio value="failed">已核实失败</Radio>
              </Radio.Group>
            </Form.Item>
            {outcome && (
              <Alert
                className="mb-24"
                type="info"
                showIcon
                title={
                  outcome === 'completed'
                    ? '订单将完成并按原规则结算返佣'
                    : '订单将标记失败，不会自动补充或退款'
                }
                description={
                  outcome === 'completed'
                    ? '关联兑换码记为已使用，并发送订单完成通知。'
                    : '本次登记不会退款，兑换码仍保留占用，避免再次使用。'
                }
              />
            )}
            <Form.Item
              label="核对依据和处理备注"
              htmlFor="order-resolution-note"
              required
              extra="填写上游核对结果、工单号或账号到账情况。备注仅后台可见，请勿填写 Session、密钥或完整兑换码。"
            >
              <Input.TextArea
                id="order-resolution-note"
                aria-required
                value={note}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                showCount
                autoSize={{ minRows: 3, maxRows: 6 }}
              />
            </Form.Item>
            <Checkbox
              checked={confirmed}
              disabled={busy || !outcome}
              onChange={(e) =>
                setReviewedRevision(e.target.checked ? order.resolutionRevision : null)
              }
            >
              我已核对上游和账号实际结果，确认按所选结论登记
            </Checkbox>
          </Form>
        </>
      ) : (
        <Alert type="info" showIcon title="订单状态已更新，请关闭后查看最新结果" />
      )}
    </Modal>
  )
}
