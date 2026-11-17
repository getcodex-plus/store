import { z } from 'zod'
import { money } from './lib'
import type {
  Coupon,
  CouponDiscountKind,
  CouponItemPreview,
  CouponPreview,
  CouponScopeMode,
  CouponUpgradeProtection,
  Product,
} from './types'

export const couponCodeRegex = /^[A-Z0-9_-]{3,32}$/
export const couponReservationMs = 30 * 60_000

export function normalizeCouponCode(value: string) {
  return value.trim().toUpperCase()
}

export function extractCouponParam(search: string) {
  const params = new URLSearchParams(search)
  const raw = params.get('coupon') || params.get('promo') || ''
  if (!raw.trim()) return ''
  return normalizeCouponCode(raw)
}

export const couponCodeSchema = z
  .string()
  .transform(normalizeCouponCode)
  .pipe(z.string().regex(couponCodeRegex, '优惠码格式应为 3–32 位字母、数字、下划线或连字符'))

const optionalPositiveInt = z.number().int().min(1).max(100000000).nullable().default(null)
const optionalIsoDate = z.string().datetime({ offset: true }).nullable().default(null)

export const adminCouponInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^cpn_[a-z\d_-]{4,60}$/)
      .optional(),
    code: couponCodeSchema,
    name: z.string().trim().min(1, '请填写优惠码名称').max(80),
    note: z.string().trim().max(300).default(''),
    discountKind: z.enum(['fixed', 'percent']),
    discountValue: z.number().int().min(1).max(100000000),
    maxDiscountAmount: optionalPositiveInt,
    minAmount: z.number().int().min(0).max(100000000).default(0),
    scopeMode: z.enum(['all', 'recharge_only', 'upgrade_only', 'products']).default('all'),
    productIds: z
      .array(z.string().regex(/^[a-z\d_-]{1,64}$/))
      .max(50)
      .default([]),
    upgradeProtection: z.enum(['cost', 'min_profit', 'none']).default('cost'),
    firstOrderOnly: z.boolean().default(false),
    requireLogin: z.boolean().default(false),
    maxRedemptions: optionalPositiveInt,
    perBuyerLimit: optionalPositiveInt,
    startsAt: optionalIsoDate,
    expiresAt: optionalIsoDate,
    allowReferral: z.boolean().default(true),
    affiliateEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine((v) => v === '' || z.email().safeParse(v).success, '请填写有效的推广员邮箱')
      .nullable()
      .default(null),
    affiliateRateBps: z.number().int().min(0).max(900).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.discountKind === 'fixed') {
      if (value.maxDiscountAmount !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['maxDiscountAmount'],
          message: '固定立减优惠码无需设置最高封顶金额',
        })
      }
    } else if (value.discountValue < 1 || value.discountValue > 9900) {
      ctx.addIssue({
        code: 'custom',
        path: ['discountValue'],
        message: '比例减免范围应为 0.01%–99%（1–9900 bps）',
      })
    }
    if (value.scopeMode === 'products' && value.productIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['productIds'],
        message: '指定套餐模式下请至少选择一个适用套餐',
      })
    }
    if (
      value.startsAt &&
      value.expiresAt &&
      Date.parse(value.startsAt) >= Date.parse(value.expiresAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: '结束时间必须晚于开始时间',
      })
    }
    if (!value.affiliateEmail && value.affiliateRateBps !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['affiliateRateBps'],
        message: '设置推广专属返佣比例前，请先绑定推广员邮箱',
      })
    }
  })

export type AdminCouponInput = z.infer<typeof adminCouponInputSchema>

export type CouponRuleShape = Pick<
  Coupon,
  | 'discountKind'
  | 'discountValue'
  | 'maxDiscountAmount'
  | 'minAmount'
  | 'scopeMode'
  | 'productIds'
  | 'upgradeProtection'
>

export function matchesCouponScope(
  coupon: Pick<Coupon, 'scopeMode' | 'productIds'>,
  product: Pick<Product, 'id' | 'upgrade'>,
) {
  if (coupon.scopeMode === 'all') return true
  if (coupon.scopeMode === 'recharge_only') return !product.upgrade
  if (coupon.scopeMode === 'upgrade_only') return product.upgrade
  return coupon.productIds.includes(product.id)
}

export function rawCouponDiscount(
  coupon: Pick<Coupon, 'discountKind' | 'discountValue' | 'maxDiscountAmount'>,
  listAmount: number,
) {
  if (!Number.isSafeInteger(listAmount) || listAmount <= 0) return 0
  if (coupon.discountKind === 'fixed') return coupon.discountValue
  const raw = Math.floor((listAmount * coupon.discountValue) / 10000)
  return coupon.maxDiscountAmount !== null ? Math.min(raw, coupon.maxDiscountAmount) : raw
}

export interface UpgradeSnapshotLike {
  mode?: string
  usdCents?: number
  fxRateBps?: number
  minimumProfit?: number
  rateE8?: number
  providerQuote?: {
    amount_minor: number
    currency?: string
    currency_decimals?: number
  }
  rules?: {
    fxRateBps?: number
    minimumProfit?: number
  }
  exchangeRate?: {
    rateE8?: number
  }
}

export function upgradeFloorFromSnapshot(
  snapshot: UpgradeSnapshotLike | undefined,
  upgradeProtection: CouponUpgradeProtection,
  liveProviderQuote?: { amount_minor: number; currency_decimals?: number },
): number | null {
  if (upgradeProtection === 'none') return 1
  if (!snapshot) return null
  const amountMinor =
    liveProviderQuote?.amount_minor ?? snapshot.providerQuote?.amount_minor ?? snapshot.usdCents
  const digits =
    liveProviderQuote?.currency_decimals ?? snapshot.providerQuote?.currency_decimals ?? 2
  const rules = snapshot.rules ?? snapshot
  const rateE8 =
    snapshot.rateE8 ??
    snapshot.exchangeRate?.rateE8 ??
    (typeof rules.fxRateBps === 'number' && rules.fxRateBps > 0
      ? rules.fxRateBps * 10000
      : undefined)
  if (
    amountMinor === undefined ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    !Number.isInteger(digits) ||
    digits < 0 ||
    digits > 6 ||
    rateE8 === undefined ||
    !Number.isSafeInteger(rateE8) ||
    rateE8 <= 0
  ) {
    return null
  }
  const costDenominator = 100000000n * 10n ** BigInt(digits)
  const costNumerator = BigInt(amountMinor) * BigInt(rateE8) * 100n
  const cost = Number((costNumerator + costDenominator - 1n) / costDenominator)
  const minProfit = upgradeProtection === 'min_profit' ? (rules.minimumProfit ?? 0) : 0
  return Math.max(1, cost + Math.max(0, minProfit))
}

export function evaluateCouponPrice(
  coupon: CouponRuleShape,
  target: {
    product: Pick<Product, 'id' | 'upgrade'>
    listAmount: number
    pricingSnapshot?: UpgradeSnapshotLike
    liveProviderQuote?: { amount_minor: number; currency_decimals?: number }
  },
): Omit<CouponItemPreview, 'productId'> {
  const { product, listAmount } = target
  if (!matchesCouponScope(coupon, product)) {
    return {
      eligible: false,
      upgradeDynamic: false,
      listAmount,
      discountAmount: 0,
      finalAmount: listAmount,
      costFloorCapped: false,
      reason: '此优惠码不适用于当前套餐',
    }
  }
  if (product.upgrade && listAmount <= 0) {
    return {
      eligible: true,
      upgradeDynamic: true,
      listAmount: 0,
      discountAmount: 0,
      finalAmount: 0,
      costFloorCapped: false,
    }
  }
  if (!Number.isSafeInteger(listAmount) || listAmount <= 0) {
    return {
      eligible: false,
      upgradeDynamic: false,
      listAmount: 0,
      discountAmount: 0,
      finalAmount: 0,
      costFloorCapped: false,
      reason: '当前套餐价格待更新',
    }
  }
  if (listAmount < coupon.minAmount) {
    return {
      eligible: false,
      upgradeDynamic: false,
      listAmount,
      discountAmount: 0,
      finalAmount: listAmount,
      costFloorCapped: false,
      reason: `满 ${money(coupon.minAmount)} 可用`,
    }
  }
  let floor = 1
  if (product.upgrade && coupon.upgradeProtection !== 'none') {
    const upgradeFloor = upgradeFloorFromSnapshot(
      target.pricingSnapshot,
      coupon.upgradeProtection,
      target.liveProviderQuote,
    )
    if (upgradeFloor === null) {
      return {
        eligible: false,
        upgradeDynamic: false,
        listAmount,
        discountAmount: 0,
        finalAmount: listAmount,
        costFloorCapped: false,
        reason: '升级成本信息缺失，暂不可叠加此优惠码',
      }
    }
    floor = Math.max(1, upgradeFloor)
  }
  if (listAmount <= floor) {
    return {
      eligible: false,
      upgradeDynamic: false,
      listAmount,
      discountAmount: 0,
      finalAmount: listAmount,
      costFloorCapped: product.upgrade && floor > 1,
      reason:
        product.upgrade && floor > 1
          ? '当前升级报价已达成本保护底线，无法叠加此优惠码'
          : '当前商品金额不支持继续减免',
    }
  }
  const rawDiscount = rawCouponDiscount(coupon, listAmount)
  const maxAllowedDiscount = listAmount - floor
  const discountAmount = Math.min(rawDiscount, maxAllowedDiscount)
  if (discountAmount <= 0) {
    return {
      eligible: false,
      upgradeDynamic: false,
      listAmount,
      discountAmount: 0,
      finalAmount: listAmount,
      costFloorCapped: false,
      reason: '当前订单金额未达到可减免额度',
    }
  }
  return {
    eligible: true,
    upgradeDynamic: false,
    listAmount,
    discountAmount,
    finalAmount: listAmount - discountAmount,
    costFloorCapped: product.upgrade && floor > 1 && rawDiscount > maxAllowedDiscount,
  }
}

export function formatCouponBenefit(coupon: {
  discountKind: CouponDiscountKind
  discountValue: number
  maxDiscountAmount?: number | null
}) {
  if (coupon.discountKind === 'fixed') return `立减 ${money(coupon.discountValue)}`
  const percentOff = Number((coupon.discountValue / 100).toFixed(2))
  const zhe = (10000 - coupon.discountValue) / 1000
  const cleanZhe = Math.abs(zhe * 10 - Math.round(zhe * 10)) < 1e-6 && zhe >= 0.5 && zhe < 10
  const base = cleanZhe
    ? `${Number(zhe.toFixed(1))} 折（减 ${percentOff}%）`
    : `立减 ${percentOff}%`
  return coupon.maxDiscountAmount ? `${base} · 最高减 ${money(coupon.maxDiscountAmount)}` : base
}

export function formatCouponScope(
  coupon: { scopeMode: CouponScopeMode; minAmount?: number; firstOrderOnly?: boolean },
  productNames?: string[],
) {
  const parts: string[] = []
  if (coupon.scopeMode === 'all') parts.push('全站套餐通用')
  else if (coupon.scopeMode === 'recharge_only') parts.push('直充套餐可用')
  else if (coupon.scopeMode === 'upgrade_only') parts.push('升级服务可用')
  else if (productNames?.length) parts.push(`限 ${productNames.join(' / ')}`)
  else parts.push('指定套餐可用')
  if (coupon.minAmount && coupon.minAmount > 0) parts.push(`满 ${money(coupon.minAmount)}`)
  if (coupon.firstOrderOnly) parts.push('仅首单')
  return parts.join(' · ')
}

export function productCouponPreview(
  product: Pick<Product, 'id' | 'price' | 'upgrade'>,
  preview: CouponPreview | null | undefined,
): CouponItemPreview | null {
  if (!preview?.valid) return null
  return preview.items[product.id] ?? null
}
