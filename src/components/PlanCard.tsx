import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Product } from '../types'
import { money } from '../lib'
import { serviceTerms } from '../product-copy'

export function PlanCard({
  product,
  title = product.name,
  selector,
}: {
  product: Product
  title?: string
  selector?: ReactNode
}) {
  return (
    <article className={`plan-card ${product.featured ? 'featured' : ''}`}>
      <div className="plan-card-top">
        {!selector && (
          <span className={`plan-symbol ${product.upgrade ? 'upgrade' : ''}`} aria-hidden="true">
            {product.upgrade ? '↗' : product.featured ? '✳' : '✦'}
          </span>
        )}
        {selector || (product.featured && <span className="recommend">日常使用推荐</span>)}
      </div>
      <h3>{title}</h3>
      <p className="plan-subtitle">{product.subtitle}</p>
      <div className="plan-price-block" aria-live="polite" aria-atomic="true">
        <span className="plan-price-caption">{product.upgrade ? '本次升级' : '本次总价'}</span>
        <div className="price">
          {product.upgrade || product.priceStatus === 'pending' ? (
            <strong className="quote-price-label">
              {product.upgrade ? '验证账号后报价' : '价格更新中'}
            </strong>
          ) : (
            <strong>{money(product.price)}</strong>
          )}
        </div>
        <div className="plan-service">
          <span>服务期限与交付范围</span>
          <p className="price-note">{serviceTerms(product)}</p>
        </div>
      </div>
      <Link
        className={product.featured ? 'primary-link plan-button' : 'secondary-link plan-button'}
        href={`/checkout?product=${product.id}`}
      >
        {product.upgrade ? '查看本次报价' : '选择此套餐'} <span aria-hidden="true">→</span>
      </Link>
      <p className="plan-action-note">先检查账号，确认后再付款</p>
      <ul>
        {product.features.map((feature) => (
          <li key={feature}>
            <span>✓</span>
            {feature}
          </li>
        ))}
      </ul>
      <Link
        href={`/plans/${product.id}`}
        className="plan-detail"
        aria-label={`了解套餐详情：${product.name}`}
      >
        了解套餐详情 ↗
      </Link>
    </article>
  )
}
