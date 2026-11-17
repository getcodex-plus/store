import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Product } from '../types'
import { planComparisons } from '../plan-comparison'
import { PlanPrice } from './PlanPrice'

export function PlanCard({
  product,
  title = product.name,
  selector,
}: {
  product: Product
  title?: string
  selector?: ReactNode
}) {
  const comparison = !product.upgrade ? planComparisons[product.plan] : undefined
  return (
    <article className={`plan-card ${product.featured ? 'featured' : ''}`}>
      <div className="plan-card-top">
        <span className={`plan-symbol ${product.upgrade ? 'upgrade' : ''}`} aria-hidden="true">
          {product.upgrade ? '↗' : product.featured ? '✳' : '✦'}
        </span>
        {selector || (product.featured && <span className="recommend">日常使用推荐</span>)}
      </div>
      <h3>{title}</h3>
      <p className="plan-subtitle">{product.subtitle}</p>
      <PlanPrice product={product} variant="card" />
      <Link
        className={product.featured ? 'primary-link plan-button' : 'secondary-link plan-button'}
        href={`/checkout?product=${product.id}`}
      >
        {product.upgrade ? '查看本次报价' : '选择此套餐'} <span aria-hidden="true">→</span>
      </Link>
      <ul>
        {(comparison?.contents ?? product.features).map((feature) => (
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
