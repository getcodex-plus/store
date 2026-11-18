'use client'
import type { Product } from '../types'
import { money } from '../lib'
import { productCouponPreview } from '../coupons'
import { useSite } from './Providers'

export function PlanPrice({
  product,
  variant = 'card',
}: {
  product: Product
  variant?: 'card' | 'hero' | 'table' | 'detail'
}) {
  const { coupon } = useSite()
  const preview = productCouponPreview(product, coupon)
  const pending = product.priceStatus === 'pending'
  const hasDiscount = !pending && Boolean(preview?.eligible && preview.discountAmount > 0)
  const thresholdHint =
    !pending && preview && !preview.eligible && preview.reason?.startsWith('满 ')
      ? preview.reason
      : ''

  if (variant === 'hero') {
    return (
      <div className="entry-price" aria-live="polite" aria-atomic="true">
        {pending ? (
          <strong>价格更新中</strong>
        ) : hasDiscount && preview ? (
          <>
            <strong>{money(preview.finalAmount)}</strong>
            <del className="price-original inverse">{money(preview.listAmount)}</del>
            <span>/ 月</span>
            <span className="coupon-diff-badge inverse">已省 {money(preview.discountAmount)}</span>
          </>
        ) : (
          <>
            <strong>{money(product.price)}</strong>
            <span>/ 月</span>
            {thresholdHint && (
              <span className="coupon-threshold-hint inverse">{thresholdHint}</span>
            )}
          </>
        )}
      </div>
    )
  }

  if (variant === 'table') {
    if (pending) return <strong>价格更新中</strong>
    if (hasDiscount && preview) {
      return (
        <div className="comparison-price-stack">
          <strong>{money(preview.finalAmount)} / 月</strong>
          <del className="price-original">{money(preview.listAmount)}</del>
          <span className="coupon-diff-badge">省 {money(preview.discountAmount)}</span>
        </div>
      )
    }
    return (
      <>
        <strong>{money(product.price)} / 月</strong>
        {thresholdHint && <span className="coupon-threshold-hint">{thresholdHint}</span>}
      </>
    )
  }

  if (variant === 'detail') {
    return (
      <div className="detail-price" aria-live="polite" aria-atomic="true">
        {pending ? (
          <>
            价格更新中 <span>/ 月</span>
          </>
        ) : hasDiscount && preview ? (
          <>
            {money(preview.finalAmount)}{' '}
            <del className="price-original detail">{money(preview.listAmount)}</del>{' '}
            <span>/ 月</span>{' '}
            <span className="coupon-diff-badge">
              券码 {coupon?.code} 已省 {money(preview.discountAmount)}
            </span>
          </>
        ) : (
          <>
            {money(product.price)} <span>/ 月</span>
            {thresholdHint && <span className="coupon-threshold-hint ml-8">{thresholdHint}</span>}
          </>
        )}
      </div>
    )
  }

  // Default: 'card'
  return (
    <div className="plan-price-block" aria-live="polite" aria-atomic="true">
      <span className="plan-price-caption">{hasDiscount ? '券后每月订阅' : '每月订阅'}</span>
      <div className="price">
        {pending ? (
          <strong className="quote-price-label">价格更新中</strong>
        ) : hasDiscount && preview ? (
          <>
            <strong>{money(preview.finalAmount)}</strong>
            <del className="price-original">{money(preview.listAmount)}</del>
            <span>/ 月</span>
            <span className="coupon-diff-badge">已省 {money(preview.discountAmount)}</span>
          </>
        ) : (
          <>
            <strong>{money(product.price)}</strong>
            <span>/ 月</span>
          </>
        )}
      </div>
      {thresholdHint && <p className="price-note">{thresholdHint}</p>}
    </div>
  )
}
