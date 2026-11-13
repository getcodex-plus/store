import type { Product } from './types'

export function serviceTerms(product: Pick<Product, 'serviceTerms'>) {
  return product.serviceTerms?.trim() || '服务期限与交付范围尚未公布，请在购买前联系支持确认。'
}

export const refundSummary =
  '已确认充值失败的订单，经核实后可退回本站钱包，不会自动原路退回支付账户。游客需先用联系邮箱登录认领订单。'
