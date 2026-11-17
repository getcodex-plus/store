import { z } from 'zod'

export const sources = ['direct', 'google', 'bing', 'baidu', 'referral', 'coupon', 'other'] as const
export type FunnelSource = (typeof sources)[number]
export const clientEvents = ['plan_view', 'checkout_view', 'verify_started'] as const
export type ClientEvent = (typeof clientEvents)[number]
export const sourceSchema = z.enum(sources)
export const funnelSchema = z
  .object({
    event: z.enum(clientEvents),
    productId: z.string().regex(/^[a-z\d_-]{1,64}$/),
    source: sourceSchema,
  })
  .strict()
export const funnelLabels: Record<string, string> = {
  plan_view: '查看套餐详情',
  checkout_view: '进入结算',
  verify_started: '开始账号检查',
  quote_ready: '取得有效报价',
  order_created: '创建订单',
  payment_succeeded: '确认付款',
  delivery_completed: '完成交付',
  order_refunded: '退款完成',
}
export const sourceLabels: Record<FunnelSource, string> = {
  direct: '直接访问',
  google: 'Google',
  bing: 'Bing',
  baidu: '百度',
  referral: '邀请链接',
  coupon: '优惠链接',
  other: '其他来源',
}
export interface FunnelRow {
  event: string
  source: FunnelSource
  events: number
  visitors: number
}

export function classifySource(search: string, referrer: string, origin: string): FunnelSource {
  const params = new URLSearchParams(search)
  const promo = (params.get('coupon') || params.get('promo') || '').trim().toUpperCase()
  if (/^[A-Z0-9_-]{3,32}$/.test(promo)) return 'coupon'
  if (/^[a-z\d]{10,12}$/.test(params.get('ref') || '')) return 'referral'
  const utm = params.get('utm_source')?.toLowerCase()
  if (utm)
    return ['google', 'bing', 'baidu', 'coupon'].includes(utm) ? (utm as FunnelSource) : 'other'
  if (!referrer) return 'direct'
  try {
    const url = new URL(referrer)
    if (url.origin === origin) return 'direct'
    if (/(^|\.)google\.(com|co\.uk|com\.hk|com\.tw|co\.jp)$/.test(url.hostname)) return 'google'
    if (/(^|\.)bing\.com$/.test(url.hostname)) return 'bing'
    if (/(^|\.)baidu\.com$/.test(url.hostname)) return 'baidu'
  } catch {
    return 'direct'
  }
  return 'other'
}
