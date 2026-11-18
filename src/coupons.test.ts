import { describe, expect, it } from 'vitest'
import {
  adminCouponInputSchema,
  evaluateCouponPrice,
  extractCouponParam,
  formatCouponBenefit,
  formatCouponScope,
  normalizeCouponCode,
} from './coupons'

describe('coupon domain pricing and validation', () => {
  it('normalizes coupon codes and extracts ?coupon or ?promo query params', () => {
    expect(normalizeCouponCode('  plus_2026  ')).toBe('PLUS_2026')
    expect(extractCouponParam('?coupon=save20')).toBe('SAVE20')
    expect(extractCouponParam('?promo=kol-50&ref=abc')).toBe('KOL-50')
    expect(extractCouponParam('?ref=onlyref')).toBe('')
  })

  it('validates admin coupon schema invariants', () => {
    expect(
      adminCouponInputSchema.safeParse({
        code: 'plus20',
        name: 'Plus 立减 20',
        discountKind: 'fixed',
        discountValue: 2000,
        maxDiscountAmount: 1000,
      }).success,
    ).toBe(false)

    expect(
      adminCouponInputSchema.safeParse({
        code: 'vip99',
        name: '超限折扣',
        discountKind: 'percent',
        discountValue: 9950,
      }).success,
    ).toBe(false)

    expect(
      adminCouponInputSchema.safeParse({
        code: 'prodonly',
        name: '指定套餐未选商品',
        discountKind: 'fixed',
        discountValue: 1000,
        scopeMode: 'products',
        productIds: [],
      }).success,
    ).toBe(false)

    const valid = adminCouponInputSchema.parse({
      code: '  kol_85 ',
      name: 'KOL 85 折',
      discountKind: 'percent',
      discountValue: 1500,
      maxDiscountAmount: 5000,
      minAmount: 10000,
      scopeMode: 'all',
      affiliateEmail: 'KOL@Example.com',
      affiliateRateBps: 500,
    })
    expect(valid.code).toBe('KOL_85')
    expect(valid.affiliateEmail).toBe('kol@example.com')
  })

  it('computes fixed and capped percentage discounts while enforcing ¥0.01 minimum payable', () => {
    const fixed = evaluateCouponPrice(
      {
        discountKind: 'fixed',
        discountValue: 20000,
        maxDiscountAmount: null,
        minAmount: 0,
        scopeMode: 'all',
        productIds: [],
        upgradeProtection: 'cost',
      },
      { product: { id: 'plus', upgrade: false }, listAmount: 14500 },
    )
    expect(fixed).toMatchObject({
      eligible: true,
      listAmount: 14500,
      discountAmount: 14499,
      finalAmount: 1,
    })

    const cappedPercent = evaluateCouponPrice(
      {
        discountKind: 'percent',
        discountValue: 2000, // 20% off
        maxDiscountAmount: 3000, // max ¥30
        minAmount: 10000,
        scopeMode: 'recharge_only',
        productIds: [],
        upgradeProtection: 'cost',
      },
      { product: { id: 'pro20', upgrade: false }, listAmount: 20000 },
    )
    expect(cappedPercent).toMatchObject({
      eligible: true,
      listAmount: 20000,
      discountAmount: 3000,
      finalAmount: 17000,
    })
  })

  it('enforces minAmount and product scope rules cleanly', () => {
    const belowThreshold = evaluateCouponPrice(
      {
        discountKind: 'fixed',
        discountValue: 2000,
        maxDiscountAmount: null,
        minAmount: 15000,
        scopeMode: 'all',
        productIds: [],
        upgradeProtection: 'cost',
      },
      { product: { id: 'go', upgrade: false }, listAmount: 4500 },
    )
    expect(belowThreshold.eligible).toBe(false)
    expect(belowThreshold.reason).toContain('满 ¥150.00 可用')

    const wrongScope = evaluateCouponPrice(
      {
        discountKind: 'fixed',
        discountValue: 2000,
        maxDiscountAmount: null,
        minAmount: 0,
        scopeMode: 'products',
        productIds: ['pro20'],
        upgradeProtection: 'cost',
      },
      { product: { id: 'plus', upgrade: false }, listAmount: 14500 },
    )
    expect(wrongScope.eligible).toBe(false)
  })

  it('does not advertise discounts on retired upgrades even for sitewide coupons', () => {
    const catalogPreview = evaluateCouponPrice(
      {
        discountKind: 'fixed',
        discountValue: 5000,
        maxDiscountAmount: null,
        minAmount: 0,
        scopeMode: 'all',
        productIds: [],
        upgradeProtection: 'cost',
      },
      { product: { id: 'upgrade-pro20', upgrade: true }, listAmount: 0 },
    )
    expect(catalogPreview).toMatchObject({
      eligible: false,
      upgradeDynamic: false,
      discountAmount: 0,
    })
  })

  it('formats human-readable benefit and scope descriptions', () => {
    expect(formatCouponBenefit({ discountKind: 'fixed', discountValue: 2500 })).toBe('立减 ¥25.00')
    expect(
      formatCouponBenefit({
        discountKind: 'percent',
        discountValue: 1500,
        maxDiscountAmount: 5000,
      }),
    ).toBe('8.5 折（减 15%） · 最高减 ¥50.00')
    expect(
      formatCouponScope({ scopeMode: 'products', minAmount: 10000, firstOrderOnly: true }, [
        'ChatGPT Plus',
      ]),
    ).toBe('限 ChatGPT Plus · 满 ¥100.00 · 仅首单')
  })
})
