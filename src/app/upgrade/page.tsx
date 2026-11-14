import Link from 'next/link'
import { products } from '../../server/services'
import { pageMetadata } from '../../seo'
import { Support } from '../../components/Support'
import { refundSummary } from '../../product-copy'

export const dynamic = 'force-dynamic'
export const metadata = pageMetadata(
  'ChatGPT 订阅升级｜账号条件与报价流程',
  '已有 ChatGPT 订阅如何升级？了解账号检查、最终总价、报价有效期和异常订单处理。',
  '/upgrade',
)
export default async function Upgrade() {
  const offers = (await products()).filter((p) => p.upgrade)
  return (
    <main className="container prose-page">
      <div className="eyebrow">READY FOR MORE</div>
      <h1>ChatGPT 订阅升级：适用条件与报价流程</h1>
      <p className="lead">使用自己的账号，选择目标套餐。检查通过后再核对本次总价，无需提前付款。</p>
      <h2>充值与升级有什么区别？</h2>
      <p>
        普通充值按在售商品价格收费；升级需要检查当前订阅及目标套餐，再确认本次应付金额。是否支持升级，以账号检查结果为准。
      </p>
      <h2>已有 Plus 或 Pro，可以直接购买更高档位吗？</h2>
      <p>
        请先检查当前账号，再确认目标套餐是否可升级。当前订阅、账号状态和目标档位都会影响本次适用性，
        不能仅凭套餐名称判断。检查未通过或结果不明确时，先联系支持确认。
      </p>
      <h2>选择升级目标</h2>
      <ul>
        {offers.map((p) => (
          <li key={p.id}>
            <Link href={`/plans/${p.id}`}>{p.name}：查看条件与服务说明 →</Link>
          </li>
        ))}
      </ul>
      {!offers.length && <p>目前没有上架的升级服务。</p>}
      <h2>如何确认最终价格？</h2>
      <ol>
        <li>进入目标套餐，填写联系邮箱与有权使用的账号信息。</li>
        <li>检查通过后，核对当前套餐、目标套餐、充值邮箱与本次总价。</li>
        <li>在报价有效时间内确认订单。报价过期时重新验证，付款前再次确认金额。</li>
      </ol>
      <p>下单后，本订单金额不会因后台调价而改变。支付成功后若需要更新账号信息，继续原订单即可。</p>
      <h2>升级价格是两个套餐的售价差额吗？</h2>
      <p>
        不能直接用本站两个普通充值套餐的售价相减。升级金额根据当前账号的检查结果计算，
        付款前会展示本次总价和报价有效时间。是否支持升级、最终金额及服务内容，都应以本次确认的信息为准。
      </p>
      <h2>报价过期，或者换了充值账号怎么办？</h2>
      <p>
        报价过期后需要重新检查账号并确认金额；更换账号后也需要重新检查。
        已付款订单如提示更新账号信息，请在原订单内提交同一充值账号的新信息， 参阅
        <Link href="/guide#account-info">充值账号信息准备说明</Link>。
      </p>
      <h2>升级失败怎么办？</h2>
      <p>{refundSummary}</p>
      <div className="catalog-links">
        <Link href="/compare">比较普通充值套餐</Link>
        <Link href="/help/payment">到账与退款说明</Link>
      </div>
      <Support />
    </main>
  )
}
