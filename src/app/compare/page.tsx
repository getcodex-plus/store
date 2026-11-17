import Link from 'next/link'
import { products } from '../../server/services'
import { planComparisons } from '../../plan-comparison'
import { pageMetadata } from '../../seo'
import { Support } from '../../components/Support'
import { PlanPrice } from '../../components/PlanPrice'

export const dynamic = 'force-dynamic'
export const metadata = pageMetadata(
  'ChatGPT Go、Plus 与 Pro 套餐对比｜价格与选购建议',
  '比较 ChatGPT Go、Plus 和 Pro 各档位的套餐内容、适合的用户与每月价格，按自己的使用需求选择。',
  '/compare',
)
export default async function Compare() {
  const planOrder = ['go', 'plus', 'pro5', 'pro20', 'promax']
  const catalog = (await products())
    .filter((p) => !p.upgrade)
    .sort(
      (a, b) =>
        (planOrder.indexOf(a.plan) < 0 ? planOrder.length : planOrder.indexOf(a.plan)) -
        (planOrder.indexOf(b.plan) < 0 ? planOrder.length : planOrder.indexOf(b.plan)),
    )
  return (
    <main className="container prose-page comparison-page">
      <div className="eyebrow">FIND YOUR FIT</div>
      <h1>ChatGPT Go、Plus 与 Pro 套餐对比</h1>
      <p className="lead">
        从偶尔问答到每天用 AI 工作，先看套餐内容和适合的用户，再按使用频率与预算选择。
      </p>
      <div
        className="comparison-scroll"
        role="region"
        aria-label="套餐内容与适合的用户对比"
        tabIndex={0}
      >
        <table className="comparison-table">
          <caption>套餐内容与适合的用户</caption>
          <thead>
            <tr>
              <th scope="col">套餐</th>
              <th scope="col">适合的用户</th>
              <th scope="col">套餐内容</th>
              <th scope="col">每月价格</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((p) => {
              const comparison = planComparisons[p.plan]
              return (
                <tr key={p.id}>
                  <th scope="row">
                    <Link href={`/plans/${p.id}`}>{p.name}</Link>
                  </th>
                  <td>
                    <strong>{comparison?.audience ?? p.subtitle}</strong>
                    <p className="muted">{comparison?.scenarios ?? p.description}</p>
                  </td>
                  <td>
                    <ul>
                      {(comparison?.contents ?? p.features).map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="comparison-price">
                    <PlanPrice product={p} variant="table" />
                    <Link href={`/plans/${p.id}`} aria-label={`查看${p.name}详情`}>
                      查看详情 →
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!catalog.length && <p>暂时没有上架的充值套餐，请稍后再来。</p>}
      <p className="comparison-source">
        适合的用户与场景为选购建议。功能参考{' '}
        <a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noopener noreferrer">
          OpenAI 套餐说明
        </a>
        。额度倍数以 Plus 的 Work / Codex 额度为基准；Pro 无 5 小时限额，仍有周额度限制。
        实际功能及用量以账号内显示为准。表中价格为本站每月充值价格。
      </p>
      <h2>不确定选哪档？推荐从 Plus 开始。</h2>
      <p>
        推荐先从 Plus
        开始，用于日常学习、写作和编程。使用一段时间后，如果额度不够用，或需要更长时间连续工作，
        再根据实际用量选择 Pro 100、Pro 200 或 Pro 500。
      </p>
      <h2>Plus 和 Pro 怎么选？先看实际使用情况</h2>
      <p>
        如果你还没有遇到影响工作的用量限制，可以先按预算选择，记录自己常用的任务和使用频率。
        如果经常因额度不足中断工作，再比较 Pro 各档位的内容与每月价格，确认增加的预算是否符合需求。
      </p>
      <p>
        套餐名称不能代替具体服务说明。购买前打开对应详情，核对订阅期限、目标套餐和账号条件；
        对未说明的服务内容，先联系支持确认。
      </p>
      <h2>这里的价格包含什么？会自动续费吗？</h2>
      <p>
        表中金额是本站普通充值服务的每月价格，服务内容以对应商品说明及付款前确认的信息为准。
        本站按订单一次性收款，不自动续扣；账号自身的订阅续费设置需要另行确认。
        已有订阅需要升级时，应先检查账号并获取升级报价。
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
