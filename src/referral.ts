import type { Commission, ReferralTier, Settings, Withdrawal } from './types'

export const defaultReferralTiers: ReferralTier[] = [
  { id: 'starter', name: '邀请新星', minimumInvites: 0, rateBps: 200 },
  { id: 'sharer', name: '分享达人', minimumInvites: 5, rateBps: 300 },
  { id: 'ambassador', name: '推荐官', minimumInvites: 20, rateBps: 400 },
  { id: 'partner', name: '邀请合伙人', minimumInvites: 50, rateBps: 500 },
]

export function referralProgress(
  qualifiedInvites: number,
  settings: Pick<Settings, 'referralTiers'>,
) {
  const tiers = settings.referralTiers ?? defaultReferralTiers
  let currentIndex = 0
  tiers.forEach((tier, index) => {
    if (qualifiedInvites >= tier.minimumInvites) currentIndex = index
  })
  const current = tiers[Math.max(0, currentIndex)]
  const next = tiers[currentIndex + 1] ?? null
  return {
    qualifiedInvites,
    current,
    next,
    remaining: next ? Math.max(0, next.minimumInvites - qualifiedInvites) : 0,
    progress: next
      ? Math.min(
          100,
          Math.max(
            0,
            ((qualifiedInvites - current.minimumInvites) /
              (next.minimumInvites - current.minimumInvites)) *
              100,
          ),
        )
      : 100,
    tiers,
  }
}

export function referralFunds(
  commissions: Pick<Commission, 'amount' | 'status'>[],
  withdrawals: Pick<Withdrawal, 'amount' | 'status'>[],
) {
  const settled = commissions
    .filter((entry) => entry.status === 'available')
    .reduce((sum, entry) => sum + entry.amount, 0)
  const pending = commissions
    .filter((entry) => entry.status === 'pending')
    .reduce((sum, entry) => sum + entry.amount, 0)
  const frozen = withdrawals
    .filter((entry) => entry.status === 'pending' || entry.status === 'processing')
    .reduce((sum, entry) => sum + entry.amount, 0)
  const withdrawn = withdrawals
    .filter((entry) => entry.status === 'paid')
    .reduce((sum, entry) => sum + entry.amount, 0)
  return {
    settled,
    pending,
    frozen,
    withdrawn,
    available: Math.max(0, settled - frozen - withdrawn),
    shortfall: Math.max(0, frozen + withdrawn - settled),
  }
}

export const withdrawalStatuses: Record<Withdrawal['status'], { text: string; color: string }> = {
  pending: { text: '待审核', color: 'processing' },
  processing: { text: '打款处理中', color: 'processing' },
  paid: { text: '已打款', color: 'success' },
  rejected: { text: '已拒绝 · 额度已释放', color: 'default' },
}
