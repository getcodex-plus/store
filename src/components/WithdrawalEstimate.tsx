'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Space, Statistic } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { api, money } from '../lib'
import type { WithdrawalEstimate as Estimate } from '../types'

export function WithdrawalEstimate({
  withdrawalId,
  canFill,
  onUse,
}: {
  withdrawalId: string
  canFill: boolean
  onUse: (amount: number) => void
}) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const pending = useRef<{ withdrawalId: string; promise: Promise<Estimate> } | null>(null)
  const load = useCallback(
    async (refresh = false) => {
      const current = ++request.current
      setLoading(true)
      setEstimate(null)
      setError('')
      try {
        // Reuse an in-flight initial request if React replays the mount effect.
        if (refresh || pending.current?.withdrawalId !== withdrawalId)
          pending.current = {
            withdrawalId,
            promise: api<Estimate>('/admin/withdrawals/estimate', { id: withdrawalId, refresh }),
          }
        const result = await pending.current!.promise
        if (current !== request.current) return
        if (Date.parse(result.expiresAt) <= Date.now())
          throw new Error('参考汇率已过期，请重新获取')
        setEstimate(result)
      } catch (e) {
        if (current === request.current) setError((e as Error).message)
      } finally {
        if (current === request.current) setLoading(false)
      }
    },
    [withdrawalId],
  )
  useEffect(() => {
    void load()
    return () => {
      request.current++
    }
  }, [load])
  useEffect(() => {
    if (!estimate) return
    const timer = setTimeout(
      () => {
        setEstimate(null)
        setError('参考汇率已过期，请重新获取')
      },
      Math.max(0, Date.parse(estimate.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [estimate])

  return (
    <Card size="small" className="mt-24" title="USDT 打款参考">
      {loading && (
        <p className="muted" role="status">
          正在获取参考汇率…
        </p>
      )}
      {error && <Alert className="mb-24" type="warning" showIcon title={error} />}
      {estimate && (
        <>
          <Statistic
            title="参考转账数量"
            value={estimate.estimatedUsdt}
            precision={6}
            suffix="USDT"
          />
          <p>
            本单净额 {money(estimate.netAmount)} ÷ {estimate.rate} CNY/USDT
          </p>
          <p className="tiny muted">
            来源：{estimate.source}
            <br />
            数据日期：{estimate.sourceDate}
            <br />
            获取时间：{new Date(estimate.fetchedAt).toLocaleString()}
          </p>
          {estimate.refreshFailed && (
            <Alert
              className="mb-24"
              type="warning"
              showIcon
              title="本次汇率刷新未成功，当前显示仍有效的缓存参考价"
            />
          )}
        </>
      )}
      <Space wrap>
        <Button
          aria-label="刷新参考数量"
          icon={<ReloadOutlined aria-hidden="true" />}
          loading={loading}
          onClick={() => void load(true)}
        >
          刷新参考数量
        </Button>
        {canFill && (
          <Button
            disabled={!estimate || loading}
            onClick={() => estimate && onUse(Number(estimate.estimatedUsdt))}
          >
            填入参考数量
          </Button>
        )}
      </Space>
      <p className="tiny muted mt-24">
        这是参考汇率折算，不含交易所价差和额外链上费用。请按与申请人确认的数量打款，再登记实际到账数量。
      </p>
    </Card>
  )
}
