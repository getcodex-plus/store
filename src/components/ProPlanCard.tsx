'use client'
import { useId, useState } from 'react'
import { Radio } from 'antd'
import type { Product } from '../types'
import { PlanCard } from './PlanCard'

const tiers: Record<string, string> = { pro5: '100', pro20: '200', promax: '500' }

export function ProPlanCard({ products }: { products: Product[] }) {
  const [selected, setSelected] = useState(products[0]?.id)
  const groupName = useId()
  const product = products.find((p) => p.id === selected) ?? products[0]
  if (!product) return null
  return (
    <PlanCard
      product={product}
      title="ChatGPT Pro"
      selector={
        <Radio.Group
          name={groupName}
          aria-label="Pro 套餐档位"
          className="pro-tier-selector"
          optionType="button"
          buttonStyle="solid"
          value={product.id}
          onChange={(event) => setSelected(event.target.value)}
          options={products.map((p) => ({
            value: p.id,
            label: `Pro ${tiers[p.plan]}`,
            title: p.name,
          }))}
        />
      }
    />
  )
}
