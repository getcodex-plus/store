import {
  adminCouponInputSchema,
  couponCodeSchema,
  couponReservationMs,
  evaluateCouponPrice,
  formatCouponBenefit,
  formatCouponScope,
  normalizeCouponCode,
  type UpgradeSnapshotLike,
} from '../coupons'
import type {
  AdminCoupon,
  AffiliateCouponSummary,
  Coupon,
  CouponItemPreview,
  CouponPreview,
  Product,
  User,
} from '../types'
import { ApiError } from './config'
import { hash, id } from './crypto'
import { couponView, jsonInput, quoteView } from './data'
import { advisoryLock, databaseNow, lockRow } from './database-sql'
import { db, Prisma, transaction, type DbClient } from './db'
import { riskDigest } from './risk'

const paidPurchaseStatuses = ['processing', 'completed', 'needs_session']

function buyerHashes(contactEmail: string, targetEmail: string) {
  return {
    buyerKey: hash(`buyer:${targetEmail.trim().toLowerCase()}`),
    contactKey: hash(`contact:${contactEmail.trim().toLowerCase()}`),
  }
}

async function refundLockedOrderBalance(
  client: DbClient,
  userId: string,
  amount: number,
  orderId: string,
) {
  await client.wallet.createMany({ data: [{ userId }], skipDuplicates: true })
  await lockRow(client, 'wallets', userId)
  const exists = await client.walletEntry.findUnique({
    where: { orderId_kind: { orderId, kind: 'refund' } },
  })
  if (exists) return
  const current = await client.wallet.findUniqueOrThrow({ where: { userId } })
  const balance = current.balance + amount
  await client.wallet.update({ where: { userId }, data: { balance } })
  await client.walletEntry.create({
    data: { id: id('l_'), userId, amount, balanceAfter: balance, kind: 'refund', orderId },
  })
}

export async function releaseExpiredCouponOrders(couponId?: string) {
  const now = await databaseNow()
  const expired = await db.couponRedemption.findMany({
    where: {
      status: 'reserved',
      expiresAt: { lte: now },
      ...(couponId ? { couponId } : {}),
    },
    select: { id: true, orderId: true },
    take: 50,
    orderBy: { expiresAt: 'asc' },
  })
  for (const item of expired) {
    await transaction(async (client) => {
      await lockRow(client, 'orders', item.orderId)
      const order = await client.order.findUnique({ where: { id: item.orderId } })
      const currentNow = await databaseNow(client)
      if (!order) {
        await client.couponRedemption.updateMany({
          where: { id: item.id, status: 'reserved' },
          data: { status: 'released', expiresAt: null, updatedAt: currentNow },
        })
        return
      }
      if (order.status === 'cancelled' || order.status === 'refunded') {
        await client.couponRedemption.updateMany({
          where: { id: item.id, status: { not: 'released' } },
          data: { status: 'released', expiresAt: null, updatedAt: currentNow },
        })
        return
      }
      if (order.status !== 'unpaid' || order.paymentAttempted) {
        // Payment has been initiated or received; keep the slot bound to this order.
        await client.couponRedemption.updateMany({
          where: { id: item.id, status: 'reserved' },
          data: { expiresAt: null, updatedAt: currentNow },
        })
        return
      }
      if (order.balanceAmount > 0 && order.userId) {
        await refundLockedOrderBalance(client, order.userId, order.balanceAmount, order.id)
      }
      await client.order.update({ where: { id: order.id }, data: { status: 'cancelled' } })
      if (order.quoteId) {
        await client.inventory.updateMany({
          where: {
            status: 'reserved',
            quotes: {
              some: { id: order.quoteId },
              none: { order: { status: { not: 'cancelled' } } },
            },
          },
          data: { status: 'available', reservedUntil: null },
        })
        await client.quote.updateMany({
          where: { id: order.quoteId },
          data: { preflightToken: null },
        })
      }
      await client.couponRedemption.updateMany({
        where: { id: item.id, status: 'reserved' },
        data: { status: 'released', expiresAt: null, updatedAt: currentNow },
      })
    })
  }
}

async function hasPreviousPurchase(
  client: DbClient,
  identities: { userId?: string | null; contactEmail?: string | null; targetEmail?: string | null },
) {
  const filters: Prisma.OrderWhereInput[] = []
  if (identities.userId) filters.push({ userId: identities.userId })
  if (identities.contactEmail) filters.push({ contactEmail: identities.contactEmail.toLowerCase() })
  if (identities.targetEmail) filters.push({ email: identities.targetEmail.toLowerCase() })
  if (!filters.length) return false
  const found = await client.order.findFirst({
    where: {
      kind: 'purchase',
      status: { in: paidPurchaseStatuses },
      OR: filters,
    },
    select: { id: true },
  })
  return Boolean(found)
}

async function buyerRedemptionCount(
  client: DbClient,
  couponId: string,
  identities: { userId?: string | null; contactKey?: string | null; buyerKey?: string | null },
) {
  const filters: Prisma.CouponRedemptionWhereInput[] = []
  if (identities.userId) filters.push({ userId: identities.userId })
  if (identities.contactKey) filters.push({ contactKey: identities.contactKey })
  if (identities.buyerKey) filters.push({ buyerKey: identities.buyerKey })
  if (!filters.length) return 0
  return client.couponRedemption.count({
    where: {
      couponId,
      status: { not: 'released' },
      OR: filters,
    },
  })
}

export async function previewCoupon(
  rawInput: { code: string; quoteId?: string },
  user: User | null,
  browser: string,
  catalog: Product[],
): Promise<CouponPreview> {
  const normalized = normalizeCouponCode(rawInput.code).slice(0, 32)
  const parsed = couponCodeSchema.safeParse(rawInput.code)
  if (!parsed.success) {
    return {
      valid: false,
      code: normalized,
      reason: parsed.error.issues[0]?.message ?? '优惠码格式不正确',
      items: {},
    }
  }
  const code = parsed.data
  const record = await db.coupon.findUnique({
    where: { code },
    include: {
      affiliateUser: {
        select: { id: true, email: true, referralCode: true, disabled: true },
      },
    },
  })
  if (!record || !record.enabled) {
    return { valid: false, code, reason: '优惠码不存在或已停用', items: {} }
  }
  await releaseExpiredCouponOrders(record.id)
  const coupon = couponView(record)
  const now = await databaseNow()
  if (record.startsAt && record.startsAt.getTime() > now.getTime()) {
    return { valid: false, code, reason: '此优惠码尚未开始生效', items: {} }
  }
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, code, reason: '此优惠码已过期', items: {} }
  }
  if (coupon.maxRedemptions !== null) {
    const used = await db.couponRedemption.count({
      where: { couponId: coupon.id, status: { not: 'released' } },
    })
    if (used >= coupon.maxRedemptions) {
      return { valid: false, code, reason: '此优惠码名额已领完', items: {} }
    }
  }
  if (user) {
    if (
      record.affiliateUser &&
      (record.affiliateUser.id === user.id ||
        record.affiliateUser.email.toLowerCase() === user.email.toLowerCase())
    ) {
      return { valid: false, code, reason: '不能使用自己的专属推广优惠码', items: {} }
    }
    if (coupon.perBuyerLimit !== null) {
      const contactKey = hash(`contact:${user.email.toLowerCase()}`)
      const count = await buyerRedemptionCount(db, coupon.id, {
        userId: user.id,
        contactKey,
      })
      if (count >= coupon.perBuyerLimit) {
        return {
          valid: false,
          code,
          reason:
            coupon.perBuyerLimit === 1
              ? '您已使用过此优惠码（含待支付订单）'
              : `此优惠码每人限用 ${coupon.perBuyerLimit} 次`,
          items: {},
        }
      }
    }
    if (
      coupon.firstOrderOnly &&
      (await hasPreviousPurchase(db, { userId: user.id, contactEmail: user.email }))
    ) {
      return { valid: false, code, reason: '此优惠码仅限首单新用户使用', items: {} }
    }
  }

  const productNames =
    coupon.scopeMode === 'products'
      ? catalog.filter((p) => coupon.productIds.includes(p.id)).map((p) => p.name)
      : undefined
  const items: Record<string, CouponItemPreview> = {}
  for (const product of catalog) {
    items[product.id] = {
      productId: product.id,
      ...evaluateCouponPrice(coupon, {
        product,
        listAmount: product.upgrade ? 0 : product.price,
      }),
    }
  }

  let quotePreview: CouponPreview['quote']
  if (rawInput.quoteId) {
    const storedQuote = await db.quote.findFirst({
      where: { id: rawInput.quoteId, browserDigest: browser },
    })
    if (storedQuote && storedQuote.expiresAt.getTime() > now.getTime()) {
      const quote = quoteView(storedQuote)
      const targetProduct =
        catalog.find((p) => p.id === quote.productId) ??
        (await db.product.findUnique({ where: { id: quote.productId } }))
      if (targetProduct) {
        const { buyerKey, contactKey } = buyerHashes(user?.email ?? quote.email, quote.email)
        let blockedReason = ''
        if (coupon.requireLogin && !user) {
          blockedReason = '此优惠码需登录后使用'
        } else if (
          record.affiliateUser &&
          record.affiliateUser.email.toLowerCase() === quote.email.toLowerCase()
        ) {
          blockedReason = '不能给推广员自己的账号使用专属优惠码'
        } else if (coupon.perBuyerLimit !== null) {
          const usedByTarget = await buyerRedemptionCount(db, coupon.id, {
            userId: user?.id,
            contactKey: user ? contactKey : undefined,
            buyerKey,
          })
          if (usedByTarget >= coupon.perBuyerLimit) {
            blockedReason =
              coupon.perBuyerLimit === 1
                ? '当前账号已使用过此优惠码（含待支付订单）'
                : `此优惠码每个账号限用 ${coupon.perBuyerLimit} 次`
          }
        }
        if (
          !blockedReason &&
          coupon.firstOrderOnly &&
          (await hasPreviousPurchase(db, {
            userId: user?.id,
            contactEmail: user?.email,
            targetEmail: quote.email,
          }))
        ) {
          blockedReason = '当前充值账号已有历史成功订单，仅限首单可用'
        }
        if (blockedReason) {
          quotePreview = {
            quoteId: quote.id,
            eligible: false,
            listAmount: quote.amount,
            discountAmount: 0,
            finalAmount: quote.amount,
            costFloorCapped: false,
            reason: blockedReason,
          }
        } else {
          const evaluated = evaluateCouponPrice(coupon, {
            product: { id: targetProduct.id, upgrade: targetProduct.upgrade },
            listAmount: quote.amount,
            pricingSnapshot: quote.pricingSnapshot as UpgradeSnapshotLike | undefined,
          })
          quotePreview = {
            quoteId: quote.id,
            eligible: evaluated.eligible,
            listAmount: evaluated.listAmount,
            discountAmount: evaluated.discountAmount,
            finalAmount: evaluated.finalAmount,
            costFloorCapped: evaluated.costFloorCapped,
            reason: evaluated.reason,
          }
        }
      }
    }
  }

  return {
    valid: true,
    code: coupon.code,
    name: coupon.name,
    summary: formatCouponBenefit(coupon),
    scopeLabel: formatCouponScope(coupon, productNames),
    discountKind: coupon.discountKind,
    discountValue: coupon.discountValue,
    maxDiscountAmount: coupon.maxDiscountAmount,
    minAmount: coupon.minAmount,
    scopeMode: coupon.scopeMode,
    productIds: coupon.productIds,
    upgradeProtection: coupon.upgradeProtection,
    firstOrderOnly: coupon.firstOrderOnly,
    requireLogin: coupon.requireLogin,
    allowReferral: coupon.allowReferral,
    affiliateReferralCode:
      record.affiliateUser && !record.affiliateUser.disabled
        ? record.affiliateUser.referralCode
        : null,
    expiresAt: coupon.expiresAt,
    items,
    ...(quotePreview ? { quote: quotePreview } : {}),
  }
}

export interface CouponValidationContext {
  user: User | null
  contactEmail: string
  targetEmail: string
  product: Pick<Product, 'id' | 'upgrade'>
  listAmount: number
  pricingSnapshot?: UpgradeSnapshotLike
  liveProviderQuote?: { amount_minor: number; currency_decimals?: number }
}

async function assertCouponEligible(client: DbClient, code: string, ctx: CouponValidationContext) {
  const record = await client.coupon.findUnique({
    where: { code },
    include: {
      affiliateUser: {
        select: {
          id: true,
          email: true,
          referralCode: true,
          referralTierId: true,
          disabled: true,
        },
      },
    },
  })
  if (!record || !record.enabled) throw new ApiError(409, '优惠码不存在或已停用')
  const coupon = couponView(record)
  const now = await databaseNow(client)
  if (record.startsAt && record.startsAt.getTime() > now.getTime()) {
    throw new ApiError(409, '此优惠码尚未开始生效')
  }
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(409, '此优惠码已过期')
  }
  if (coupon.requireLogin && !ctx.user) {
    throw new ApiError(401, '此优惠码需要先登录后使用')
  }
  if (
    record.affiliateUser &&
    (record.affiliateUser.id === ctx.user?.id ||
      [ctx.contactEmail.toLowerCase(), ctx.targetEmail.toLowerCase()].includes(
        record.affiliateUser.email.toLowerCase(),
      ))
  ) {
    throw new ApiError(409, '不能使用自己的专属推广优惠码')
  }
  if (coupon.maxRedemptions !== null) {
    const used = await client.couponRedemption.count({
      where: { couponId: coupon.id, status: { not: 'released' } },
    })
    if (used >= coupon.maxRedemptions) {
      throw new ApiError(409, '此优惠码名额已领完')
    }
  }
  const { buyerKey, contactKey } = buyerHashes(ctx.contactEmail, ctx.targetEmail)
  if (coupon.perBuyerLimit !== null) {
    const count = await buyerRedemptionCount(client, coupon.id, {
      userId: ctx.user?.id,
      contactKey,
      buyerKey,
    })
    if (count >= coupon.perBuyerLimit) {
      throw new ApiError(
        409,
        coupon.perBuyerLimit === 1
          ? '您已使用过此优惠码（含待支付订单）'
          : `此优惠码每人限用 ${coupon.perBuyerLimit} 次`,
      )
    }
  }
  if (
    coupon.firstOrderOnly &&
    (await hasPreviousPurchase(client, {
      userId: ctx.user?.id,
      contactEmail: ctx.contactEmail,
      targetEmail: ctx.targetEmail,
    }))
  ) {
    throw new ApiError(409, '此优惠码仅限首单新用户使用')
  }
  const evaluated = evaluateCouponPrice(coupon, {
    product: ctx.product,
    listAmount: ctx.listAmount,
    pricingSnapshot: ctx.pricingSnapshot,
    liveProviderQuote: ctx.liveProviderQuote,
  })
  if (!evaluated.eligible || evaluated.discountAmount <= 0) {
    throw new ApiError(409, evaluated.reason || '当前订单不满足此优惠码的使用条件')
  }
  return {
    coupon,
    affiliateUser: record.affiliateUser,
    buyerKey,
    contactKey,
    now,
    evaluated,
  }
}

export async function precheckCouponForOrder(rawCode: string, ctx: CouponValidationContext) {
  const parsed = couponCodeSchema.safeParse(rawCode)
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message ?? '优惠码格式不正确')
  }
  const code = parsed.data
  const found = await db.coupon.findUnique({ where: { code }, select: { id: true } })
  if (found) await releaseExpiredCouponOrders(found.id)
  return assertCouponEligible(db, code, ctx)
}

export async function reserveCouponInTransaction(
  client: DbClient,
  couponId: string,
  code: string,
  orderId: string,
  ctx: CouponValidationContext,
) {
  await lockRow(client, 'coupons', couponId)
  const lockSubjects = [
    ...(ctx.user ? [`coupon:${couponId}:${riskDigest('user', ctx.user.id)}`] : []),
    `coupon:${couponId}:${riskDigest('email', ctx.contactEmail)}`,
    `coupon:${couponId}:${riskDigest('target', ctx.targetEmail)}`,
  ].sort()
  for (const key of new Set(lockSubjects)) {
    await advisoryLock(client, key)
  }
  const verified = await assertCouponEligible(client, code, ctx)
  const snapshot = jsonInput({
    id: verified.coupon.id,
    code: verified.coupon.code,
    name: verified.coupon.name,
    discountKind: verified.coupon.discountKind,
    discountValue: verified.coupon.discountValue,
    maxDiscountAmount: verified.coupon.maxDiscountAmount,
    minAmount: verified.coupon.minAmount,
    scopeMode: verified.coupon.scopeMode,
    upgradeProtection: verified.coupon.upgradeProtection,
    allowReferral: verified.coupon.allowReferral,
    affiliateUserId: verified.coupon.affiliateUserId,
    affiliateRateBps: verified.coupon.affiliateRateBps,
    listAmount: verified.evaluated.listAmount,
    discountAmount: verified.evaluated.discountAmount,
    finalAmount: verified.evaluated.finalAmount,
    costFloorCapped: verified.evaluated.costFloorCapped,
  })
  return {
    coupon: verified.coupon,
    affiliateUser: verified.affiliateUser,
    listAmount: verified.evaluated.listAmount,
    discountAmount: verified.evaluated.discountAmount,
    finalAmount: verified.evaluated.finalAmount,
    snapshot,
    createRedemption: async (unpaid: boolean) => {
      await client.couponRedemption.create({
        data: {
          id: id('cr_'),
          couponId: verified.coupon.id,
          orderId,
          status: 'reserved',
          userId: ctx.user?.id ?? null,
          buyerKey: verified.buyerKey,
          contactKey: verified.contactKey,
          discountAmount: verified.evaluated.discountAmount,
          expiresAt: unpaid ? new Date(verified.now.getTime() + couponReservationMs) : null,
          createdAt: verified.now,
          updatedAt: verified.now,
        },
      })
    },
  }
}

export async function confirmCouponOrderPaid(client: DbClient, orderId: string) {
  await client.couponRedemption.updateMany({
    where: { orderId, status: 'reserved' },
    data: { expiresAt: null, updatedAt: await databaseNow(client) },
  })
}

export async function markCouponOrderRedeemed(client: DbClient, orderId: string) {
  await client.couponRedemption.updateMany({
    where: { orderId, status: { in: ['reserved', 'redeemed'] } },
    data: { status: 'redeemed', expiresAt: null, updatedAt: await databaseNow(client) },
  })
}

export async function releaseCouponOrder(client: DbClient, orderId: string) {
  await client.couponRedemption.updateMany({
    where: { orderId, status: { not: 'released' } },
    data: { status: 'released', expiresAt: null, updatedAt: await databaseNow(client) },
  })
}

export async function affiliateCouponsForUser(
  client: DbClient,
  userId: string,
): Promise<AffiliateCouponSummary[]> {
  const now = await databaseNow(client)
  const records = await client.coupon.findMany({
    where: {
      affiliateUserId: userId,
      enabled: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!records.length) return []
  const counts = await client.couponRedemption.groupBy({
    by: ['couponId'],
    where: {
      couponId: { in: records.map((r) => r.id) },
      status: 'redeemed',
    },
    _count: { _all: true },
  })
  const redeemedByCoupon = new Map(counts.map((row) => [row.couponId, row._count._all]))
  return records.map((record) => {
    const view = couponView(record)
    return {
      id: view.id,
      code: view.code,
      name: view.name,
      discountKind: view.discountKind,
      discountValue: view.discountValue,
      maxDiscountAmount: view.maxDiscountAmount,
      minAmount: view.minAmount,
      scopeMode: view.scopeMode,
      productIds: view.productIds,
      affiliateRateBps: view.affiliateRateBps,
      expiresAt: view.expiresAt,
      redeemedCount: redeemedByCoupon.get(view.id) ?? 0,
    }
  })
}

export async function adminCouponsList(options: {
  search?: string
  take: number
  skip: number
}): Promise<{ rows: AdminCoupon[]; total: number }> {
  const trimmed = options.search?.trim() ?? ''
  const where: Prisma.CouponWhereInput = trimmed
    ? {
        OR: [
          { code: { contains: trimmed, mode: 'insensitive' } },
          { name: { contains: trimmed, mode: 'insensitive' } },
          { note: { contains: trimmed, mode: 'insensitive' } },
          { affiliateUser: { email: { contains: trimmed, mode: 'insensitive' } } },
        ],
      }
    : {}
  const [total, records] = await Promise.all([
    db.coupon.count({ where }),
    db.coupon.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.take,
      skip: options.skip,
      include: {
        affiliateUser: { select: { email: true, referralCode: true } },
      },
    }),
  ])
  if (!records.length) return { rows: [], total }
  const ids = records.map((r) => r.id)
  const [redemptionStats, orderStats] = await Promise.all([
    db.couponRedemption.groupBy({
      by: ['couponId', 'status'],
      where: { couponId: { in: ids }, status: { in: ['reserved', 'redeemed'] } },
      _count: { _all: true },
    }),
    db.order.groupBy({
      by: ['couponId'],
      where: {
        couponId: { in: ids },
        kind: 'purchase',
        status: { in: paidPurchaseStatuses },
      },
      _sum: { discountAmount: true, amount: true },
    }),
  ])
  const reservedMap = new Map<string, number>()
  const redeemedMap = new Map<string, number>()
  for (const stat of redemptionStats) {
    if (stat.status === 'reserved') reservedMap.set(stat.couponId, stat._count._all)
    if (stat.status === 'redeemed') redeemedMap.set(stat.couponId, stat._count._all)
  }
  const orderStatMap = new Map(
    orderStats.map((stat) => [
      stat.couponId!,
      {
        totalDiscountAmount: stat._sum.discountAmount ?? 0,
        totalOrderAmount: stat._sum.amount ?? 0,
      },
    ]),
  )
  const rows: AdminCoupon[] = records.map((record) => {
    const base = couponView(record)
    const totals = orderStatMap.get(record.id)
    return {
      ...base,
      affiliateEmail: record.affiliateUser?.email ?? null,
      affiliateReferralCode: record.affiliateUser?.referralCode ?? null,
      reservedCount: reservedMap.get(record.id) ?? 0,
      redeemedCount: redeemedMap.get(record.id) ?? 0,
      totalDiscountAmount: totals?.totalDiscountAmount ?? 0,
      totalOrderAmount: totals?.totalOrderAmount ?? 0,
    }
  })
  return { rows, total }
}

export async function saveAdminCoupon(
  actorEmail: string,
  rawData: unknown,
  auditFn: (actor: string, action: string, target: string, client: DbClient) => Promise<void>,
): Promise<{ saved: true; coupon: Coupon }> {
  const parsed = adminCouponInputSchema.safeParse(rawData)
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message ?? '请检查优惠码配置')
  }
  const input = parsed.data
  const uniqueProductIds = input.scopeMode === 'products' ? [...new Set(input.productIds)] : []
  return transaction(async (client) => {
    if (uniqueProductIds.length > 0) {
      const foundProducts = await client.product.count({
        where: { id: { in: uniqueProductIds } },
      })
      if (foundProducts !== uniqueProductIds.length) {
        throw new ApiError(400, '所选适用套餐中包含不存在的商品')
      }
    }
    let affiliateUserId: string | null = null
    if (input.affiliateEmail) {
      const affiliate = await client.user.findUnique({
        where: { email: input.affiliateEmail },
        select: { id: true },
      })
      if (!affiliate) {
        throw new ApiError(400, '未找到该推广员邮箱对应的注册账号，请先确认邮箱已注册')
      }
      affiliateUserId = affiliate.id
    }
    const now = await databaseNow(client)
    const couponId = input.id ?? id('cpn_')
    if (input.id) {
      await lockRow(client, 'coupons', input.id)
      const existing = await client.coupon.findUnique({ where: { id: input.id } })
      if (!existing) throw new ApiError(404, '优惠码不存在')
    }
    const conflict = await client.coupon.findFirst({
      where: {
        code: input.code,
        ...(input.id ? { id: { not: input.id } } : {}),
      },
      select: { id: true },
    })
    if (conflict) throw new ApiError(409, `优惠码 ${input.code} 已存在，请更换编码`)
    const payload = {
      code: input.code,
      name: input.name,
      note: input.note,
      discountKind: input.discountKind,
      discountValue: input.discountValue,
      maxDiscountAmount: input.discountKind === 'percent' ? input.maxDiscountAmount : null,
      minAmount: input.minAmount,
      scopeMode: input.scopeMode,
      productIds: uniqueProductIds,
      upgradeProtection: input.upgradeProtection,
      firstOrderOnly: input.firstOrderOnly,
      requireLogin: input.requireLogin,
      maxRedemptions: input.maxRedemptions,
      perBuyerLimit: input.perBuyerLimit,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      allowReferral: input.allowReferral,
      affiliateUserId,
      affiliateRateBps: affiliateUserId ? input.affiliateRateBps : null,
      enabled: input.enabled,
      updatedAt: now,
    }
    const saved = input.id
      ? await client.coupon.update({ where: { id: input.id }, data: payload })
      : await client.coupon.create({ data: { id: couponId, ...payload, createdAt: now } })
    await auditFn(
      actorEmail,
      input.id ? `更新优惠码 ${saved.code}` : `创建优惠码 ${saved.code}`,
      saved.id,
      client,
    )
    return { saved: true, coupon: couponView(saved) }
  })
}
