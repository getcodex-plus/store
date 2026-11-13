import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
vi.mock('./config', () => ({
  integration: async () => ({
    id: 'revision',
    url: 'https://gateway.example',
    appId: 'test-app',
    pid: 'test-merchant',
    secret: 'test-only',
    key: 'test-only',
    privateKey: keys.privateKey,
  }),
}))
import { createPayment, type PaymentOrder } from './payments'
afterEach(() => vi.unstubAllGlobals())
it('sends only the external payment amount through every supported gateway', async () => {
  for (const provider of ['xorpay', 'gmpay', 'epay_v1', 'epay_v2'] as const) {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            aoid: 'tx',
            info: { qr: 'https://pay.example' },
            data: { trade_id: 'tx', payment_url: 'https://pay.example' },
            code: provider === 'epay_v2' ? 0 : 1,
            trade_no: 'tx',
            payurl: 'https://pay.example',
            pay_type: 'jump',
            pay_info: 'https://pay.example',
          }),
        ),
    )
    vi.stubGlobal('fetch', fetcher)
    await createPayment(
      {
        id: 'o_test',
        provider,
        integrationId: 'revision',
        amount: 12900,
        balanceAmount: 3000,
        externalAmount: 9900,
        channel: provider === 'gmpay' ? 'crypto' : 'alipay',
        productName: 'Test',
      } as PaymentOrder,
      '127.0.0.1',
    )
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0][1]
    const fields = new URLSearchParams(String(options.body))
    expect(
      fields.get(provider === 'xorpay' ? 'price' : provider === 'gmpay' ? 'amount' : 'money'),
    ).toBe('99.00')
    expect(options.redirect).toBe('error')
  }
})
