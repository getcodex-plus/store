import Link from 'next/link'
import { products } from '../../server/services'
import { money } from '../../lib'
import { serviceTerms } from '../../product-copy'
import { pageMetadata } from '../../seo'
import { Support } from '../../components/Support'

export const dynamic = 'force-dynamic'
export const metadata = pageMetadata(
  'ChatGPT 套餐对比｜价格与购买条件',
  '比较本站在售 ChatGPT 充值套餐、价格、服务期限和购买条件，已有订阅可查看升级流程。',
  '/compare',
)
export default async function Compare() {
  const catalog = (await products()).filter((p) => !p.upgrade)
  return (
    <main className="container prose-page comparison-page">
      <div className="eyebrow">FIND YOUR FIT</div>
      <h1>先看清差别，再选择套餐。</h1>
      <p className="lead">
        以下为本站在售商品与服务说明。套餐名称中的档位标识不是人民币售价；实际金额以价格栏及付款前确认的订单为准。
      </p>
      <div className="comparison-scroll" role="region" aria-label="套餐价格与服务对比" tabIndex={0}>
        <table className="comparison-table">
          <caption>在售充值套餐</caption>
          <thead>
            <tr>
              <th scope="col">套餐</th>
              <th scope="col">本次价格</th>
              <th scope="col">服务期限与交付范围</th>
              <th scope="col">套餐说明</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <Link href={`/plans/${p.id}`}>{p.name} →</Link>
                </th>
                <td>{p.priceStatus === 'pending' ? '价格更新中' : money(p.price)}</td>
                <td>{serviceTerms(p)}</td>
                <td>
                  <p>{p.description}</p>
                  <ul>
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!catalog.length && <p>暂时没有上架的充值套餐，请稍后再来。</p>}
      <h2>应该怎样选择？</h2>
      <p>
        先确认你需要的套餐权益与使用额度，再核对本站商品的期限和交付范围。模型、额度等产品权益可能调整，本页不以未经核实的固定次数作承诺。
      </p>
      <h2>已有订阅，需要换套餐？</h2>
      <p>不要把充值与升级当作同一种服务。升级需要检查当前账号，再计算本次应付总价。</p>
      <div className="catalog-links">
        <Link href="/upgrade" className="primary-link">
          了解升级条件 →
        </Link>
        <Link href="/guide">查看购买指南</Link>
      </div>
      <Support />
    </main>
  )
}
