import type { TawkSettings } from './tawk'

export type OrderStatus =
  'unpaid' | 'processing' | 'completed' | 'needs_session' | 'failed' | 'refunded' | 'cancelled'
export type Channel = 'alipay' | 'wechat' | 'crypto' | 'balance'
export type PaymentProvider = 'xorpay' | 'gmpay' | 'epay_v1' | 'epay_v2' | 'balance'
export interface OrderRefund {
  destination: 'wallet' | 'original'
  status: 'processing' | 'review' | 'completed'
  automatic: boolean
  requestedAt: string
  completedAt: string | null
}
export interface AdminOrder extends Order {
  ipAddress: string | null
  provider: PaymentProvider
  resolutionRevision: string
  fulfillmentResolution: import('./order-resolution').OrderResolution | null
  refillHistory?: import('./order-refill').RefillHistory
  refundRecord: {
    note: string
    actor: string | null
    resolutionNote: string
    resolvedBy: string | null
  } | null
}
export interface PricingRules {
  fxRateBps: number
  markupBps: number
  serviceFee: number
  minimum: number
  minimumProfit?: number
  roundingStep?: 1 | 10 | 100 | 1000
}
export interface Product {
  id: string
  name: string
  subtitle: string
  description: string
  price: number
  features: string[]
  plan: string
  enabled: boolean
  featured: boolean
  upgrade: boolean
  pricingMode: 'fixed' | 'markup'
  priceCurrency: 'CNY' | 'USD'
  roundingStep: 1 | 10 | 100 | 1000
  priceStatus?: 'ready' | 'pending'
  enabledBatchCount?: number
}
export interface User {
  id: string
  email: string
  avatarUrl?: string
  role: 'user' | 'admin'
  referralCode: string
  referralTierId?: string | null
  invitedBy?: string
  createdAt: string
  disabled: boolean
  permissions: string[]
  roleIds?: string[]
}
export interface Order {
  kind: 'purchase' | 'topup'
  id: string
  userId: string | null
  contactEmail: string
  productId: string | null
  productName: string
  email: string
  listAmount?: number
  discountAmount?: number
  couponCode?: string | null
  amount: number
  balanceAmount: number
  externalAmount: number
  status: OrderStatus
  channel: Channel
  createdAt: string
  completedAt?: string | null
  rateBps: number
  settlementDays: number
  firstOrderOnly: boolean
  fulfillmentStatus?: string | null
  refillCount?: number
  canRefill?: boolean
  refund?: OrderRefund | null
}
export type CouponDiscountKind = 'fixed' | 'percent'
export type CouponScopeMode = 'all' | 'recharge_only' | 'upgrade_only' | 'products'
export type CouponUpgradeProtection = 'cost' | 'min_profit' | 'none'
export interface Coupon {
  id: string
  code: string
  name: string
  note: string
  discountKind: CouponDiscountKind
  discountValue: number
  maxDiscountAmount: number | null
  minAmount: number
  scopeMode: CouponScopeMode
  productIds: string[]
  upgradeProtection: CouponUpgradeProtection
  firstOrderOnly: boolean
  requireLogin: boolean
  maxRedemptions: number | null
  perBuyerLimit: number | null
  startsAt: string | null
  expiresAt: string | null
  allowReferral: boolean
  affiliateUserId: string | null
  affiliateRateBps: number | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}
export interface AdminCoupon extends Coupon {
  affiliateEmail: string | null
  affiliateReferralCode: string | null
  reservedCount: number
  redeemedCount: number
  totalDiscountAmount: number
  totalOrderAmount: number
}
export interface AffiliateCouponSummary {
  id: string
  code: string
  name: string
  discountKind: CouponDiscountKind
  discountValue: number
  maxDiscountAmount: number | null
  minAmount: number
  scopeMode: CouponScopeMode
  productIds: string[]
  affiliateRateBps: number | null
  expiresAt: string | null
  redeemedCount: number
}
export interface CouponItemPreview {
  productId: string
  eligible: boolean
  upgradeDynamic: boolean
  listAmount: number
  discountAmount: number
  finalAmount: number
  costFloorCapped: boolean
  reason?: string
}
export interface CouponPreview {
  valid: boolean
  code: string
  name?: string
  summary?: string
  scopeLabel?: string
  discountKind?: CouponDiscountKind
  discountValue?: number
  maxDiscountAmount?: number | null
  minAmount?: number
  scopeMode?: CouponScopeMode
  productIds?: string[]
  upgradeProtection?: CouponUpgradeProtection
  firstOrderOnly?: boolean
  requireLogin?: boolean
  allowReferral?: boolean
  affiliateReferralCode?: string | null
  expiresAt?: string | null
  reason?: string
  items: Record<string, CouponItemPreview>
  quote?: {
    quoteId: string
    eligible: boolean
    listAmount: number
    discountAmount: number
    finalAmount: number
    costFloorCapped: boolean
    reason?: string
  }
}
export interface Commission {
  id: string
  userId: string
  orderId: string
  amount: number
  status: 'pending' | 'available' | 'reversed'
  availableAt: string
  createdAt: string
}
export type WithdrawalNetwork = 'TRC20' | 'ERC20' | 'BSC' | 'Polygon'
export type WithdrawalDestination = 'alipay' | 'wechat' | WithdrawalNetwork
export interface WithdrawalRule {
  minimum: number
  feeRateBps: number
  fixedFee: number
}
export interface WithdrawalChannels {
  alipay: boolean
  wechat: boolean
  usdt: boolean
  networks: Record<WithdrawalNetwork, boolean>
  rules: Record<WithdrawalDestination, WithdrawalRule>
}
export interface Withdrawal {
  id: string
  userId: string
  amount: number
  method: string
  account: string
  recipientName: string
  network: WithdrawalNetwork | null
  feeAmount: number
  feeRateBps: number
  fixedFee: number
  netAmount: number
  status: 'pending' | 'processing' | 'paid' | 'rejected'
  note: string
  payoutReference: string
  payoutAmount: string | null
  reviewerId: string | null
  reviewedAt: string | null
  createdAt: string
}
export interface WithdrawalEstimate {
  withdrawalId: string
  netAmount: number
  estimatedUsdt: string
  rate: number
  source: string
  sourceDate: string
  fetchedAt: string
  expiresAt: string
  refreshFailed: boolean
}
export interface ReferralTier {
  id: string
  name: string
  minimumInvites: number
  rateBps: number
}
export interface Settings {
  rateBps: number
  referralTiers?: ReferralTier[]
  withdrawalChannels?: WithdrawalChannels
  settlementDays: number
  firstOrderOnly: boolean
  supportEmail: string
  sessionGuideUrl?: string
  tawk?: TawkSettings
  alipay: boolean
  wechat: boolean
  crypto: boolean
  fiatProvider: 'xorpay' | 'epay_v1' | 'epay_v2'
  epayVersion?: 'epay_v1' | 'epay_v2'
  emailProvider: 'smtp' | 'resend' | 'sendflare'
  paymentLimits?: Partial<Record<Exclude<Channel, 'balance'>, { min: number; max: number }>>
  upgradePricing?: PricingRules & {
    fxMode?: 'manual' | 'auto'
    configured?: boolean
    targets?: Record<
      string,
      {
        markupBps: number
        serviceFee: number
        minimumProfit: number
        roundingStep?: 1 | 10 | 100 | 1000
      }
    >
  }
}
export interface Audit {
  id: string
  actor: string
  action: string
  target: string
  createdAt: string
}
export interface Bootstrap {
  turnstile: { siteKey: string; login: boolean; purchase: boolean }
  mode: 'demo' | 'live'
  user: User | null
  products: Product[]
  settings: Settings
}
export interface WalletEntry {
  id: string
  amount: number
  balanceAfter: number
  kind: 'topup' | 'purchase' | 'refund'
  orderId: string
  createdAt: string
}
export interface AccountData {
  orders: Order[]
  commissions: Commission[]
  withdrawals: Withdrawal[]
  invitedCount: number
  referral: {
    manual?: boolean
    qualifiedInvites: number
    current: ReferralTier
    next: ReferralTier | null
    remaining: number
    progress: number
    tiers: ReferralTier[]
  }
  available: number
  pending: number
  settled: number
  frozen: number
  shortfall: number
  withdrawn: number
  balance: number
  ledger: WalletEntry[]
  affiliateCoupons?: AffiliateCouponSummary[]
}
export interface AdminData {
  pagination?: { page: number; pageSize: number; total: number }
  pendingWithdrawalCount?: number
  overview?: {
    userCount?: number
    purchaseAmount?: number
    completedPurchaseCount?: number
    attentionOrderCount?: number
    dailyRevenue?: { date: string; amount: number }[]
  }
  riskEvents?: {
    id: string
    scene: string
    action: string
    effectiveAction: string
    mode: string
    ruleVersion: string
    reasonCodes: string[]
    referenceId: string | null
    createdAt: string
  }[]
  funnel?: import('./funnel').FunnelRow[]
  exchangeRate?: {
    rate: number | null
    sourceDate: string | null
    fetchedAt: string | null
    expiresAt: string | null
    available: boolean
    lastError: string | null
    source: string | null
  }
  users: User[]
  products: Product[]
  orders: AdminOrder[]
  coupons?: AdminCoupon[]
  commissions: Commission[]
  withdrawals: Withdrawal[]
  settings: Settings
  audit: Audit[]
  inventory: { productId: string; available: number; reserved: number; consumed: number }[]
}
export interface Quote {
  id: string
  productId: string
  email: string
  amount: number
  expiresAt: string
  currentPlan?: string
  targetPlan?: string
}
