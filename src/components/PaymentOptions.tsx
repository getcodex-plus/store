'use client'
import { Alert, Radio } from 'antd'
import { useState } from 'react'
import { useSite } from './Providers'
import { channels } from '../lib'
import { paymentLimitError } from '../pricing'

const externalChannels = ['alipay', 'wechat', 'crypto'] as const
type ExternalChannel = (typeof externalChannels)[number]

export function usePaymentChannel() {
  const { data } = useSite()
  const [preferred, setChannel] = useState<ExternalChannel>('alipay')
  const available = externalChannels.filter((channel) => data?.settings[channel])
  const channel = available.includes(preferred) ? preferred : (available[0] ?? preferred)
  return { channel, setChannel, paymentAvailable: available.length > 0 }
}

export function PaymentOptions({
  value,
  onChange,
  amount,
  disabled = false,
}: {
  value: ExternalChannel
  onChange: (value: ExternalChannel) => void
  amount?: number
  disabled?: boolean
}) {
  const { data } = useSite()
  const choices = externalChannels.filter((channel) => data?.settings[channel])
  if (!choices.length)
    return (
      <Alert
        type="warning"
        showIcon
        title="在线支付暂未开放"
        description="请稍后再试；购买套餐时，也可使用足额账户余额付款。"
      />
    )
  return (
    <Radio.Group
      aria-label="支付方式"
      className="payment-options"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {choices.map((channel) => (
        <Radio key={channel} value={channel}>
          <span className={`payment-logo ${channel}`}>
            {channel === 'alipay' ? '支' : channel === 'wechat' ? '微' : '₮'}
          </span>
          <span>{channels[channel]}</span>
          {amount !== undefined && data && paymentLimitError(data.settings, channel, amount) && (
            <small>（不在金额范围内）</small>
          )}
        </Radio>
      ))}
    </Radio.Group>
  )
}
