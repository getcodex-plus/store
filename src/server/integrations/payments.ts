import { ApiError, appUrl, demo } from '../config'
import { integration, isDisallowedPaymentHost } from './config'
import {
  decimalToMinor,
  epayV1Signature,
  epayV2Signature,
  epayV2Verify,
  gmpaySignature,
  safeEqual,
  xorpaySignature,
} from './signatures'
import type { Order } from '../../types'

export type Provider = 'xorpay' | 'gmpay' | 'epay_v1' | 'epay_v2'
export interface PaymentOrder extends Order {
  provider: Provider | 'balance'
  integrationId?: string | null
  paymentId?: string | null
  paymentUrl?: string | null
  paymentAttempted: boolean
  redemptionId?: string | null
  quoteId?: string | null
  fulfillmentAttempt: number
  aicdkIntegrationId?: string | null
  redemptionVersion: number
  submissionAttempted: boolean
}
export interface Receipt {
  orderId: string
  transactionId: string
  amount: number
  paid: boolean
  channel?: string
}
const origin = (value: string) => {
  const trimmed = value.replace(/\/$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ApiError(503, '支付网关地址格式不正确')
  }
  const live = process.env.APP_MODE === 'live' || !demo
  const allowedProtocols = live ? ['https:'] : ['http:', 'https:']
  if (
    !allowedProtocols.includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ApiError(
      503,
      live ? '正式环境支付网关必须使用 HTTPS' : '支付网关地址需使用 HTTP 或 HTTPS',
    )
  }
  if (live && isDisallowedPaymentHost(parsed.hostname)) {
    throw new ApiError(503, '正式环境支付网关地址不允许指向本地或内网地址')
  }
  return trimmed
}
export async function precheckPaymentGateway(order: PaymentOrder) {
  if (order.provider === 'balance') throw new ApiError(409, '余额订单无需创建渠道付款')
  const config = await integration(order.provider, order.integrationId ?? undefined)
  if (order.provider !== 'xorpay') origin(config.url)
  return config
}
async function post(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
    cache: 'no-store',
  })
  if (!response.ok) throw new ApiError(502, '支付渠道暂未响应，请在原订单中联系支持')
  const body = await response.json()
  return typeof body === 'string' ? JSON.parse(body) : body
}
export async function createPayment(
  order: PaymentOrder,
  clientIP: string,
  resolvedConfig?: Record<string, string>,
) {
  if (order.provider === 'balance') throw new ApiError(409, '余额订单无需创建渠道付款')
  const config =
    resolvedConfig ?? (await integration(order.provider, order.integrationId ?? undefined))
  const amount = (order.externalAmount / 100).toFixed(2)
  const notify = `${appUrl}/api/payments/notify/${order.provider}/${config.id}`
  if (order.provider === 'xorpay') {
    const fields: Record<string, string> = {
      name: order.productName,
      pay_type: order.channel === 'wechat' ? 'native' : 'alipay',
      price: amount,
      order_id: order.id,
      notify_url: notify,
      expire: '1800',
    }
    fields.sign = xorpaySignature(
      [fields.name, fields.pay_type, amount, order.id, notify],
      config.secret,
    )
    const response = await post(
      `https://xorpay.com/api/pay/${encodeURIComponent(config.appId)}`,
      fields,
    )
    if (response.status !== 'ok' || !response.aoid || !response.info?.qr)
      throw new ApiError(502, '支付渠道未返回收款信息，请联系支持核对原订单')
    return { paymentId: String(response.aoid), paymentUrl: String(response.info.qr) }
  }
  if (order.provider === 'gmpay') {
    const fields: Record<string, string> = {
      pid: config.pid,
      order_id: order.id,
      currency: 'CNY',
      amount,
      notify_url: notify,
      redirect_url: `${appUrl}/orders/${order.id}`,
      name: order.productName,
    }
    fields.signature = gmpaySignature(fields, config.secret)
    const response = await post(
      `${origin(config.url)}/payments/gmpay/v1/order/create-transaction`,
      fields,
    )
    if (!response.data?.trade_id || !response.data?.payment_url)
      throw new ApiError(502, 'GMPay 未返回收款信息，请联系支持核对原订单')
    return {
      paymentId: String(response.data.trade_id),
      paymentUrl: String(response.data.payment_url),
    }
  }
  const v2 = order.provider === 'epay_v2'
  const fields: Record<string, string> = {
    pid: config.pid,
    type: order.channel === 'wechat' ? 'wxpay' : 'alipay',
    out_trade_no: order.id,
    notify_url: notify,
    return_url: `${appUrl}/orders/${order.id}`,
    name: order.productName,
    money: amount,
    clientip: clientIP,
    ...(v2
      ? { method: 'web', timestamp: String(Math.floor(Date.now() / 1000)) }
      : { device: 'pc' }),
  }
  fields.sign = v2
    ? epayV2Signature(fields, config.privateKey)
    : epayV1Signature(fields, config.key)
  fields.sign_type = v2 ? 'RSA' : 'MD5'
  const response = await post(
    `${origin(config.url)}${v2 ? '/api/pay/create' : '/mapi.php'}`,
    fields,
  )
  if (response.code !== (v2 ? 0 : 1))
    throw new ApiError(502, '易支付暂未返回收款信息，请联系支持核对原订单')
  if (
    v2 &&
    ((response.sign_type && response.sign_type !== 'RSA') ||
      !epayV2Verify(response, config.publicKey))
  )
    throw new ApiError(502, '易支付返回签名校验失败，请联系管理员')
  const url = v2 ? response.pay_info : response.payurl || response.qrcode || response.urlscheme
  if (v2 && !['qrcode', 'jump', 'url'].includes(response.pay_type))
    throw new ApiError(502, '此易支付交互类型暂不支持，请联系管理员')
  if (!response.trade_no || typeof url !== 'string')
    throw new ApiError(502, '易支付返回的信息不完整')
  return { paymentId: String(response.trade_no), paymentUrl: url }
}
// XorPay does not expose a refund idempotency key. The caller must durably claim
// the refund before invoking this function and must never retry an unknown result.
export async function refundXorpay(paymentId: string, amount: number, secret: string) {
  if (!paymentId || !secret || !Number.isSafeInteger(amount) || amount <= 0)
    throw new ApiError(400, '退款信息不完整，请核对原支付记录')
  const price = (amount / 100).toFixed(2)
  const response = await post(`https://xorpay.com/api/refund/${encodeURIComponent(paymentId)}`, {
    price,
    sign: xorpaySignature([price], secret),
  })
  if (response?.status !== 'ok')
    throw new ApiError(502, 'XorPay 未确认退款成功，请在渠道后台核实后登记')
}

export function verifyReceipt(
  provider: Provider,
  fields: Record<string, string>,
  config: Record<string, string>,
): Receipt {
  if (provider === 'xorpay') {
    const expected = xorpaySignature(
      [fields.aoid, fields.order_id, fields.pay_price, fields.pay_time],
      config.secret,
    )
    if (!fields.sign || !safeEqual(expected, fields.sign)) throw new ApiError(400, '签名无效')
    return {
      orderId: fields.order_id,
      transactionId: fields.aoid,
      amount: decimalToMinor(fields.pay_price),
      paid: true,
    }
  }
  if (provider === 'gmpay') {
    if (
      fields.pid !== config.pid ||
      !safeEqual(gmpaySignature(fields, config.secret), fields.signature || '')
    )
      throw new ApiError(400, '签名无效')
    if (fields.currency && fields.currency !== 'CNY') throw new ApiError(400, '币种不匹配')
    return {
      orderId: fields.order_id,
      transactionId: fields.trade_id,
      amount: decimalToMinor(fields.amount),
      paid: fields.status === '2',
    }
  }
  const v2 = provider === 'epay_v2'
  if (fields.pid !== config.pid) throw new ApiError(400, '商户不匹配')
  if (fields.sign_type !== (v2 ? 'RSA' : 'MD5')) throw new ApiError(400, '签名协议不匹配')
  const valid = v2
    ? epayV2Verify(fields, config.publicKey)
    : safeEqual(epayV1Signature(fields, config.key), fields.sign || '')
  if (!valid) throw new ApiError(400, '签名无效')
  return {
    orderId: fields.out_trade_no,
    transactionId: fields.trade_no,
    amount: decimalToMinor(fields.money),
    paid: fields.trade_status === 'TRADE_SUCCESS',
    channel: fields.type === 'wxpay' ? 'wechat' : fields.type,
  }
}
export async function confirmGmpayReceipt(receipt: Receipt, config: Record<string, string>) {
  const fields: Record<string, string> = { pid: config.pid, order_id: receipt.orderId }
  fields.signature = gmpaySignature(fields, config.secret)
  const response = await fetch(
    `${origin(config.url)}/payments/gmpay/v1/order/query?${new URLSearchParams(fields)}`,
    {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      cache: 'no-store',
    },
  )
  if (!response.ok) throw new ApiError(503, '支付状态暂时无法核实')
  const result = await response.json()
  const data = result.data
  if (
    !data ||
    data.currency !== 'CNY' ||
    String(data.trade_id) !== receipt.transactionId ||
    data.order_id !== receipt.orderId ||
    decimalToMinor(String(data.amount)) !== receipt.amount ||
    Number(data.status) !== 2
  )
    throw new ApiError(400, '支付查询结果不匹配')
}
