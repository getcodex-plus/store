import Link from 'next/link'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { products } from '../../../server/services'
import { money } from '../../../lib'
import { pageMetadata, siteOrigin } from '../../../seo'
import { serviceTerms, refundSummary } from '../../../product-copy'
import { Support } from '../../../components/Support'
import { JsonLd } from '../../../components/JsonLd'
import { FunnelView } from '../../../components/FunnelView'

export const dynamic = 'force-dynamic'
const getProduct = cache(async (id: string) => (await products()).find((p) => p.id === id))
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = await getProduct(id)
  if (!product) notFound()
  return pageMetadata(
    `${product.name}｜${product.upgrade ? '升级条件与报价说明' : '充值价格与服务说明'}`,
    `${product.description} 查看服务期限、购买条件、账号验证与退款方式，确认后再付款。`,
    `/plans/${id}`,
  )
}
export default async function Plan({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = await getProduct(id)
  if (!product) notFound()
  const url = `${siteOrigin()}/plans/${id}`
  return (
    <main className="container prose-page">
      <FunnelView event="plan_view" productId={id} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: '套餐与升级', item: siteOrigin() },
            { '@type': 'ListItem', position: 2, name: product.name, item: url },
          ],
        }}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Service',
          name: product.name,
          description: product.description,
          url,
          provider: { '@type': 'Organization', name: 'GetCodex Plus', url: siteOrigin() },
          ...(!product.upgrade && product.priceStatus !== 'pending'
            ? {
                offers: {
                  '@type': 'Offer',
                  price: (product.price / 100).toFixed(2),
                  priceCurrency: 'CNY',
                  url,
                },
              }
            : {}),
        }}
      />
      <Link href="/compare" className="text-link">
        ← 比较全部套餐
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
        <span>{product.upgrade ? '确认本次总价后再付款' : '/ 本次服务'}</span>
      </div>
      <h2>服务期限与交付范围</h2>
      <p>{serviceTerms(product)}</p>
      <p>
        本站按订单一次性收款，不会自动从你的支付账户续扣。ChatGPT
        账号中的订阅续费设置，请在对应账号中确认。
      </p>
      <h2>套餐说明</h2>
      <ul>
        {product.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <h2>哪些账号可以购买？</h2>
      <p>
        服务充值至你有权使用的个人账号，不提供共享账号。已有订阅、登录方式或账号状态可能影响适用性，以本次账号检查结果为准。
      </p>
      <p>
        {product.upgrade
          ? '升级金额需检查当前订阅后计算。不要把升级价格理解为新开订阅价格，也不要默认升级会重新开始一个完整周期；请先确认本商品的期限说明。'
          : '已有订阅时，请先确认是否适合本商品。需要变更套餐可查看升级说明，不要直接重复购买。'}
      </p>
      <h2>购买后如何到账？</h2>
      <ol>
        <li>填写接收订单通知的联系邮箱，无需先注册。</li>
        <li>按指引准备账号信息，核对充值账号、服务内容与最终金额。</li>
        <li>付款后保留订单页；只有显示“充值完成”才表示已确认交付。</li>
      </ol>
      <p>处理进度以原订单为准。更换设备后，可以用联系邮箱登录查单。</p>
      <h2>失败与退款如何处理？</h2>
      <p>{refundSummary}</p>
      <p>需要更新账号信息时，继续原订单，不要再次付款。</p>
      <div className="catalog-links">
        <Link href={`/checkout?product=${id}`} className="primary-link">
          确认账号与价格 →
        </Link>
        <Link href="/guide">阅读购买指南</Link>
        <Link href="/help/payment">查看到账与退款说明</Link>
      </div>
      <Support />
    </main>
  )
}
