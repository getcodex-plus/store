export type OrderStatus =
  'unpaid' | 'processing' | 'completed' | 'needs_session' | 'failed' | 'refunded' | 'cancelled'
export type Channel = 'alipay' | 'wechat' | 'crypto' | 'balance'
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
  serviceTerms?: string
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
}
export interface User {
  id: string
  email: string
  role: 'user' | 'admin'
  referralCode: string
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
  productId: string
  productName: string
  email: string
  amount: number
  balanceAmount: number
  externalAmount: number
  status: OrderStatus
  channel: Channel
  createdAt: string
  completedAt?: string
  rateBps: number
  settlementDays: number
  firstOrderOnly: boolean
  serviceTerms?: string
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
export interface Withdrawal {
  id: string
  userId: string
  amount: number
  method: string
  account: string
  status: 'pending' | 'paid' | 'rejected'
  note: string
  createdAt: string
}
export interface Settings {
  rateBps: number
  settlementDays: number
  minimumWithdrawal: number
  firstOrderOnly: boolean
  supportEmail: string
  sessionGuideUrl?: string
  alipay: boolean
  wechat: boolean
  crypto: boolean
  fiatProvider: 'xorpay' | 'epay_v1' | 'epay_v2'
  epayVersion?: 'epay_v1' | 'epay_v2'
  emailProvider: 'smtp' | 'resend'
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
  available: number
  pending: number
  withdrawn: number
  balance: number
  ledger: WalletEntry[]
}
export interface AdminData {
  funnel?: import('./funnel').FunnelRow[]
  exchangeRate?: {
    rate: number | null
    sourceDate: string | null
    fetchedAt: string | null
    expiresAt: string | null
    available: boolean
    lastError: string | null
  }
  users: User[]
  products: Product[]
  orders: Order[]
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
  serviceTerms?: string
}
