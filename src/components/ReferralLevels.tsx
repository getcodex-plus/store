import { Card, Progress, Tag } from 'antd'
import type { AccountData } from '../types'

export function ReferralLevels({ referral }: { referral: AccountData['referral'] }) {
  return (
    <Card className="referral-levels">
      <div className="referral-level-heading">
        <div>
          <span className="eyebrow">我的邀请等级</span>
          <h2>
            {referral.current.name} <Tag>返现 {referral.current.rateBps / 100}%</Tag>
          </h2>
          <p className="muted">
            已有 {referral.qualifiedInvites} 位有效邀请
            {referral.next
              ? `，再邀请 ${referral.remaining} 位可升至${referral.next.name}。`
              : '，已达到最高等级。'}
          </p>
        </div>
        <span className="referral-level-rate">
          {referral.current.rateBps / 100}
          <small>%</small>
        </span>
      </div>
      <Progress
        percent={Math.round(referral.progress)}
        showInfo={false}
        aria-label={
          referral.next
            ? `距离${referral.next.name}还差 ${referral.remaining} 位有效邀请`
            : '已达到最高等级'
        }
      />
      <ol className="referral-level-list">
        {referral.tiers.map((tier) => (
          <li
            key={tier.id}
            aria-current={tier.id === referral.current.id ? 'step' : undefined}
            className={tier.id === referral.current.id ? 'current' : ''}
          >
            <div className="referral-level-label">
              <strong>{tier.name}</strong>
              {tier.id === referral.current.id && <Tag>当前等级</Tag>}
            </div>
            <div className="referral-level-percent">{tier.rateBps / 100}%</div>
            <span className="muted">
              {tier.minimumInvites === 0 ? '加入即可' : `${tier.minimumInvites} 位有效邀请`}
            </span>
          </li>
        ))}
      </ol>
      <p className="tiny muted">
        好友的套餐订单成功交付且收益已结算后，按联系邮箱去重计入有效邀请，游客也计入。
        等级随有效邀请人数更新；退款冲回会重新计算。新订单锁定下单时的返现比例，已有订单不变。
      </p>
    </Card>
  )
}
