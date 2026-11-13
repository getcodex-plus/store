import { z } from 'zod'
import type {
  Product as ProductRecord,
  Order as OrderRecord,
  Quote as QuoteRecord,
  User as UserRecord,
  Commission as CommissionRecord,
  Withdrawal as WithdrawalRecord,
  WalletEntry as WalletRecord,
  Audit as AuditRecord,
} from '../generated/prisma/client'
import type { Prisma } from './db'
import type {
  Product,
  Order,
  User,
  Commission,
  Withdrawal,
  WalletEntry,
  Settings,
  Audit,
} from '../types'
import type { PaymentOrder } from './integrations/payments'
import type { StoredQuote } from './services'
import type { PricingSnapshot } from './fulfillment-policy'

const orderStatus = z.enum([
  'unpaid',
  'processing',
  'completed',
  'needs_session',
  'failed',
  'refunded',
  'cancelled',
])
const channel = z.enum(['alipay', 'wechat', 'crypto', 'balance'])
const strings = z.array(z.string())
export const stringRecord = (value: Prisma.JsonValue) =>
  z.record(z.string(), z.string()).parse(value)

export function jsonInput(value: object): Prisma.InputJsonObject {
  // Strip optional undefined properties and retain ISO dates in stored snapshots.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject
}

export function settingsData(value: Prisma.JsonValue): Settings {
  return z
    .object({
      rateBps: z.number(),
      settlementDays: z.number(),
      minimumWithdrawal: z.number(),
      firstOrderOnly: z.boolean(),
      supportEmail: z.string().default(''),
      alipay: z.boolean(),
      wechat: z.boolean(),
      crypto: z.boolean(),
      fiatProvider: z.enum(['xorpay', 'epay_v1', 'epay_v2']),
      emailProvider: z.enum(['smtp', 'resend']).default('resend'),
    })
    .passthrough()
    .parse(value) as Settings
}

export function productView(record: ProductRecord): Product {
  return {
    id: record.id,
    name: record.name,
    subtitle: record.subtitle,
    description: record.description,
    price: record.price,
    features: strings.parse(record.features),
    plan: record.plan,
    enabled: record.enabled,
    featured: record.featured,
    upgrade: record.upgrade,
    pricingMode: z.enum(['fixed', 'markup']).parse(record.pricingMode),
    priceCurrency: z.enum(['CNY', 'USD']).parse(record.priceCurrency),
    roundingStep: z
      .union([z.literal(1), z.literal(10), z.literal(100), z.literal(1000)])
      .parse(record.roundingStep),
    serviceTerms: record.serviceTerms,
  }
}

export function orderView(record: OrderRecord): Order {
  return {
    id: record.id,
    userId: record.userId,
    contactEmail: record.contactEmail ?? record.email,
    productId: record.productId,
    productName: record.productName,
    email: record.email,
    kind: z.enum(['purchase', 'topup']).parse(record.kind),
    amount: record.amount,
    balanceAmount: record.balanceAmount,
    externalAmount: record.externalAmount,
    status: orderStatus.parse(record.status),
    channel: channel.parse(record.channel),
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    rateBps: record.rateBps,
    settlementDays: record.settlementDays,
    firstOrderOnly: record.firstOrderOnly,
    serviceTerms: record.serviceTerms,
    fulfillmentStatus: record.fulfillmentStatus,
  }
}

export function paymentOrderView(record: OrderRecord): PaymentOrder & {
  inviterId: string | null
  buyerKey: string | null
} {
  return {
    ...orderView(record),
    provider: z.enum(['xorpay', 'gmpay', 'epay_v1', 'epay_v2', 'balance']).parse(record.provider),
    integrationId: record.integrationId,
    paymentId: record.paymentId,
    paymentUrl: record.paymentUrl,
    paymentAttempted: record.paymentAttempted,
    redemptionId: record.redemptionId,
    quoteId: record.quoteId,
    fulfillmentAttempt: record.fulfillmentAttempt,
    aicdkIntegrationId: record.aicdkIntegrationId,
    redemptionVersion: record.redemptionVersion,
    submissionAttempted: record.submissionAttempted,
    inviterId: record.inviterId,
    buyerKey: record.buyerKey,
  }
}

export function quoteView(record: QuoteRecord): StoredQuote {
  return {
    id: record.id,
    productId: record.productId,
    email: record.email,
    amount: record.amount,
    expiresAt: record.expiresAt.toISOString(),
    currentPlan: record.currentPlan ?? undefined,
    targetPlan: record.targetPlan ?? undefined,
    serviceTerms: record.serviceTerms,
    browserDigest: record.browserDigest,
    aicdkIntegrationId: record.aicdkIntegrationId ?? undefined,
    inventoryId: record.inventoryId ?? undefined,
    preflightToken: record.preflightToken ?? undefined,
    preflightExpiresAt: record.preflightExpiresAt?.toISOString(),
    flowVersion: record.flowVersion,
    // The pricing policy creates and revalidates this server-side snapshot.
    pricingSnapshot:
      record.pricingSnapshot === null
        ? undefined
        : (z
            .object({ mode: z.enum(['fixed', 'markup']) })
            .passthrough()
            .parse(record.pricingSnapshot) as PricingSnapshot),
  }
}

export function userView(record: UserRecord, roleIds?: string[]): User {
  return {
    id: record.id,
    email: record.email,
    role: z.enum(['user', 'admin']).parse(record.role),
    referralCode: record.referralCode,
    invitedBy: record.invitedBy ?? undefined,
    createdAt: record.createdAt.toISOString(),
    disabled: record.disabled,
    permissions: [],
    ...(roleIds ? { roleIds } : {}),
  }
}

export function commissionView(record: CommissionRecord): Commission {
  return {
    id: record.id,
    userId: record.userId,
    orderId: record.orderId,
    amount: record.amount,
    status: z.enum(['pending', 'available', 'reversed']).parse(record.status),
    availableAt: record.availableAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  }
}

export function storedWithdrawalView(
  record: WithdrawalRecord,
): Withdrawal & { requestHash: string } {
  return {
    id: record.id,
    userId: record.userId,
    amount: record.amount,
    method: record.method,
    account: record.account,
    recipientName: record.recipientName,
    network: z.enum(['TRC20', 'ERC20', 'BSC', 'Polygon']).nullable().parse(record.network),
    feeAmount: record.feeAmount,
    feeRateBps: record.feeRateBps,
    fixedFee: record.fixedFee,
    netAmount: record.amount - record.feeAmount,
    status: z.enum(['pending', 'processing', 'paid', 'rejected']).parse(record.status),
    note: record.note,
    payoutReference: record.payoutReference,
    payoutAmount: record.payoutAmount?.toFixed(6) ?? null,
    reviewerId: record.reviewerId,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    requestHash: record.requestHash,
  }
}

export function walletEntryView(record: WalletRecord): WalletEntry {
  return {
    id: record.id,
    amount: record.amount,
    balanceAfter: record.balanceAfter,
    kind: z.enum(['topup', 'purchase', 'refund']).parse(record.kind),
    orderId: record.orderId,
    createdAt: record.createdAt.toISOString(),
  }
}

export function auditView(record: AuditRecord): Audit {
  return { ...record, createdAt: record.createdAt.toISOString() }
}
