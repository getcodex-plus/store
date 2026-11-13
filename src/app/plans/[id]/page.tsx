import Link from 'next/link'
import { notFound } from 'next/navigation'
import { products } from '../../../server/services'
import { money } from '../../../lib'
export const dynamic = 'force-dynamic'
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = (await products()).find((p) => p.id === id)
  return {
    title: product?.name || '套餐详情',
    description: product?.description,
    alternates: { canonical: `/plans/${id}` },
  }
}
export default async function Plan({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = (await products()).find((p) => p.id === id)
  if (!product) notFound()
  return (
    <main className="container prose-page">
      <Link href="/#plans" className="text-link">
        ← 全部套餐
      </Link>
      <div className="eyebrow mt-32">YOUR NEXT UPGRADE</div>
      <h1>{product.name}</h1>
      <p className="lead">{product.description}</p>
      <div className="detail-price">
        {product.upgrade
          ? '验证账号后报价'
          : product.priceStatus === 'pending'
            ? '价格更新中'
            : money(product.price)}{' '}
        <span>{product.upgrade ? '确认报价后再付款' : '/ 次'}</span>
      </div>
      <ul>
        {product.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <h2>购买前确认</h2>
      <p>
        服务充值至你提供的账号。账号验证通过后，结算页会显示目标账号与应付金额。请确认后再付款。
      </p>
      <p>
        不同账号的订阅状态可能影响购买条件。已有订阅的用户，请在验证时确认是否适用，避免重复购买。
      </p>
      <Link href={`/checkout?product=${id}`} className="primary-link">
        确认账号与价格 →
      </Link>
    </main>
  )
}
