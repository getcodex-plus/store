import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from '../config'
import { bodyText } from '../http'
import { supplierOrigin } from './config'

export const upstreamId = z.number().int().positive().max(2_147_483_647)
const sku = z.object({
  id: upstreamId,
  sku_code: z.string(),
  price_amount: z.string(),
  stock_quantity: z.number().int().min(-1),
  is_active: z.boolean(),
})
const product = z.object({
  id: upstreamId,
  title: z.record(z.string(), z.string()).nullable(),
  fulfillment_type: z.string(),
  is_active: z.boolean(),
  skus: z.array(sku),
})
const receipt = z.object({ order_id: upstreamId, status: z.string().min(1) })
const detail = receipt.extend({
  fulfillment: z.object({ type: z.string(), status: z.string(), payload: z.string() }).nullish(),
  items: z
    .array(z.object({ product_id: upstreamId, sku_id: upstreamId, quantity: z.number().int() }))
    .optional(),
})
export type SupplierProduct = z.infer<typeof product>
const rejections = [
  'insufficient_balance',
  'insufficient_stock',
  'stock_unavailable',
  'product_unavailable',
  'sku_unavailable',
  'invalid_order_key',
  'bad_request',
  'payment_failed',
] as const
const errorEnvelope = z.object({
  ok: z.literal(false),
  error_code: z.enum(rejections),
  order_id: upstreamId.optional(),
})
export class PurchaseRejection extends ApiError {
  constructor(
    readonly code: string,
    readonly orderId?: number,
  ) {
    super(409, `进货请求被上游拒绝（${code}）`)
  }
}

export function dujiaoSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
) {
  const digest = createHash('md5').update(body).digest('hex')
  return createHmac('sha256', secret)
    .update(`${method}\n${path.split('?')[0]}\n${timestamp}\n${digest}`)
    .digest('hex')
}

export function dujiaoClient(binding: Record<string, string>) {
  const origin = supplierOrigin(binding.url, 503)
  async function request<T>(
    method: 'GET' | 'POST',
    resource: string,
    schema: z.ZodType<T>,
    input?: object,
  ) {
    const path = `/api/v1/upstream/${resource}`
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = input === undefined ? '' : JSON.stringify(input)
    let response: Response
    let data: unknown
    try {
      response = await fetch(origin + path, {
        method,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Dujiao-Next-Api-Key': binding.apiKey,
          'Dujiao-Next-Timestamp': timestamp,
          'Dujiao-Next-Signature': dujiaoSignature(
            binding.apiSecret,
            method,
            path,
            timestamp,
            body,
          ),
          ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: input === undefined ? undefined : body,
      })
      data = JSON.parse(await bodyText(response, 2 * 1024 * 1024))
    } catch {
      throw new ApiError(502, '进货上游暂时不可用')
    }
    if (response.status !== 200 || !z.object({ ok: z.literal(true) }).safeParse(data).success) {
      const error = errorEnvelope.safeParse(data)
      if (resource === 'orders' && response.status < 500 && error.success)
        throw new PurchaseRejection(error.data.error_code, error.data.order_id)
      throw new ApiError(502, '进货上游请求未确认，请核对服务配置或稍后重试')
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success) throw new ApiError(502, '进货上游返回格式不正确')
    return parsed.data
  }
  return {
    ping: () =>
      request(
        'POST',
        'ping',
        z.object({
          site_name: z.string(),
          balance: z.string(),
          currency: z.string(),
          protocol_version: z.string(),
        }),
      ),
    list: (page: number) =>
      request(
        'GET',
        `products?page=${page}&page_size=50`,
        z.object({ items: z.array(product), total: z.number().int().nonnegative() }),
      ),
    async product(productId: number) {
      const result = await request('GET', `products/${productId}`, z.object({ product }))
      if (result.product.id !== productId) throw new ApiError(502, '上游商品标识不一致')
      return result.product
    },
    create: (key: string, skuId: number, quantity: number) =>
      request('POST', 'orders', receipt, {
        sku_id: skuId,
        quantity,
        downstream_order_no: `stock_${key}`,
        trace_id: key,
      }),
    async order(orderId: number) {
      const result = await request('GET', `orders/${orderId}`, detail)
      if (result.order_id !== orderId) throw new ApiError(502, '上游采购单号不一致')
      return result
    },
  }
}
