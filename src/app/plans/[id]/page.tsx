import Link from 'next/link'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { products } from '../../../server/services'
import { pageMetadata, siteOrigin } from '../../../seo'
import { siteBrand } from '../../../server/site-settings'
import { planBuyingAdvice, refundSummary } from '../../../product-copy'
import { Support } from '../../../components/Support'
import { JsonLd } from '../../../components/JsonLd'
import { FunnelView } from '../../../components/FunnelView'
import { PlanPrice } from '../../../components/PlanPrice'

export const dynamic = 'force-dynamic'
const getProduct = cache(async (id: string) => (await products()).find((p) => p.id === id))
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = await getProduct(id)
  if (!product) notFound()
  return pageMetadata(
    `${product.name}｜充值价格与服务说明`,
    `${product.description} 查看购买条件、账号验证与退款方式，确认后再付款。`,
    `/plans/${id}`,
  )
}
export default async function Plan({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [product, brand] = await Promise.all([getProduct(id), siteBrand()])
  if (!product) notFound()
  const url = `${siteOrigin()}/plans/${id}`
  const advice = planBuyingAdvice[product.plan]
  return (
    <main className="container prose-page">
      <FunnelView event="plan_view" productId={id} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: '充值套餐', item: siteOrigin() },
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
          provider: { '@type': 'Organization', name: brand.name, url: siteOrigin() },
          ...(product.priceStatus !== 'pending'
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
      <nav aria-label="面包屑">
        <Link href="/">充值套餐</Link>
        {' / '}
        <span aria-current="page">{product.name}</span>
      </nav>
      <div className="eyebrow mt-32">MONTHLY PLAN</div>
      <h1>{product.name}充值：价格与服务说明</h1>
      <p className="lead">{product.description}</p>
      <PlanPrice product={product} variant="detail" />
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
      {advice && (
        <>
          <h2>{product.name} 适合谁？</h2>
          <p>{advice.audience}</p>
          <p>{advice.consideration}</p>
          <p>
            <Link href="/compare">比较 ChatGPT Go、Plus 与 Pro 的套餐内容和价格 →</Link>
          </p>
        </>
      )}
      <h2>本次费用与订阅期限如何确认？</h2>
      <p>
        页面金额为本站该商品的每月充值价格，付款前仍需检查账号适用性并核对订单金额。价格更新中时，请等待可用价格后再确认购买。
      </p>
      <p>
        订阅期限与交付内容以本商品说明和付款前确认的信息为准。如说明中未明确期限，或你已有订阅但不确定如何处理，
        请先联系支持确认。本站服务不提供共享账号。
      </p>
      <h2>哪些账号可以购买？</h2>
      <p>
        服务充值至你有权使用的个人账号，不提供共享账号。已有订阅、登录方式或账号状态可能影响适用性，以本次账号检查结果为准。
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
