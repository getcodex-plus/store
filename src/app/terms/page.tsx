import { pageMetadata } from '../../seo'
import { refundSummary } from '../../product-copy'
import { Support } from '../../components/Support'
export const metadata = pageMetadata(
  '服务说明｜交付、取消与钱包退款',
  '了解 GetCodex Plus 独立充值服务的购买条件、交付确认、订单取消、钱包退款及邀请返现规则。',
  '/terms',
)
export default function Terms() {
  return (
    <main className="container prose-page">
      <h1>服务说明</h1>
      <p>GetCodex Plus 是独立充值服务，与 OpenAI 无隶属关系。套餐服务及金额以付款前确认的订单内容为准。</p>
      <h2>购买与交付</h2>
      <p>
        请确认你有权使用所提交的账号，并检查充值邮箱与目标套餐。付款确认与充值完成分别显示，只有“充值完成”表示已确认交付。
      </p>
      <h2>异常订单与退款</h2>
      <p>{refundSummary}</p>
      <p>
        钱包余额用于本站消费，不会自动退到支付宝、微信或加密货币账户。邀请收益提现与充值余额是不同账目。
      </p>
      <p>
        尚未发起渠道支付的待付款订单可申请取消，已抵扣余额会退回钱包。支付已发起或结果不确定时，需先核对付款状态。取消请求不等于退款完成。
      </p>
      <p>
        服务期限与交付范围以付款前确认的商品及订单说明为准。本站按订单一次性收费，不自动续扣；请另行核对
        ChatGPT 账号自身的订阅续费设置。
      </p>
      <h2>钱包与邀请返现</h2>
      <p>
        充值余额用于本站消费。邀请收益与充值余额分别记账；符合规则的订单完成后进入结算期，达到最低金额即可申请收益提现。禁止自邀、循环交易和退款套利。提现审核通过后由管理员登记实际打款结果。
      </p>
      <h2>演示环境</h2>
      <p>
        标注“本地演示”的环境只用于功能验证。演示商品价格、模拟付款与测试余额不代表真实交易或可兑现资金。
      </p>
      <Support />
    </main>
  )
}
