import { afterEach, expect, it, vi } from 'vitest'
import { dujiaoClient, dujiaoSignature } from './dujiao'

const client = dujiaoClient({
  url: 'https://supplier.example',
  apiKey: 'fixture-key',
  apiSecret: 'fixture',
})
afterEach(() => vi.unstubAllGlobals())

it('matches the Dujiao HMAC vector, omits query parameters and signs the actual request bytes', async () => {
  expect(
    dujiaoSignature('fixture', 'GET', '/api/v1/upstream/products?page=2', '1700000000', ''),
  ).toBe('64b157eecdd9cb43b9c83154c2c57cd7b81c715f791071b399803ae460e2555f')
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ ok: true, order_id: 42, status: 'paid' }),
  )
  vi.stubGlobal('fetch', fetcher)
  await client.create('order-key', 84, 3)
  const [url, init] = fetcher.mock.calls[0]
  const headers = new Headers(init.headers)
  expect(url).toBe('https://supplier.example/api/v1/upstream/orders')
  expect(init.redirect).toBe('error')
  expect(JSON.parse(String(init.body))).toEqual({
    sku_id: 84,
    quantity: 3,
    downstream_order_no: 'stock_order-key',
    trace_id: 'order-key',
  })
  expect(headers.get('Dujiao-Next-Api-Key')).toBe('fixture-key')
  expect(headers.get('Dujiao-Next-Signature')).toBe(
    dujiaoSignature(
      'fixture',
      'POST',
      new URL(url).pathname,
      headers.get('Dujiao-Next-Timestamp')!,
      String(init.body),
    ),
  )
})

it('pings with an empty body and reads a signed page of the native SKU catalog', async () => {
  const sku = {
    id: 8,
    sku_code: 'PLUS',
    price_amount: '98.00',
    stock_quantity: -1,
    is_active: true,
  }
  const product = {
    id: 5,
    title: { 'zh-CN': 'Plus 充值码' },
    fulfillment_type: 'auto',
    is_active: true,
    skus: [sku],
  }
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        site_name: '供货站',
        balance: '200.00',
        currency: 'CNY',
        protocol_version: '1.0',
      }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true, items: [product], total: 51 }))
  vi.stubGlobal('fetch', fetcher)
  expect((await client.ping()).balance).toBe('200.00')
  expect(await client.list(2)).toEqual({ items: [product], total: 51 })
  expect(fetcher.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    ['https://supplier.example/api/v1/upstream/ping', 'POST', undefined],
    ['https://supplier.example/api/v1/upstream/products?page=2&page_size=50', 'GET', undefined],
  ])
})

it('does not trust mismatched order IDs or put raw supplier errors into logs or responses', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true, order_id: 77, status: 'completed' }))
    .mockResolvedValueOnce(
      Response.json({
        ok: false,
        error_code: 'payment_failed',
        error_message: 'private upstream detail',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ ok: false, error_code: 'order_in_progress' }, { status: 409 }),
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(client.order(42)).rejects.toThrow('单号不一致')
  await expect(client.create('key', 84, 1)).rejects.toMatchObject({
    code: 'payment_failed',
    message: expect.not.stringContaining('private'),
  })
  await expect(client.create('key', 84, 1)).rejects.toMatchObject({ status: 502 })
})
