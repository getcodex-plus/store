import { describe, it, expect, vi } from 'vitest'
import { verifyTurnstileResult } from './turnstile'
const verifier = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
describe('Turnstile Siteverify enforcement', () => {
  it('accepts only success, matching action and deployment hostname', async () => {
    await expect(
      verifyTurnstileResult(
        'test-secret',
        'test-token',
        'purchase',
        'shop.example',
        verifier({ success: true, action: 'purchase', hostname: 'shop.example' }),
      ),
    ).resolves.toBeUndefined()
    for (const result of [
      { success: false, action: 'purchase', hostname: 'shop.example' },
      { success: true, action: 'login', hostname: 'shop.example' },
      { success: true, action: 'purchase', hostname: 'localhost' },
    ])
      await expect(
        verifyTurnstileResult(
          'test-secret',
          'test-token',
          'purchase',
          'shop.example',
          verifier(result),
        ),
      ).rejects.toThrow()
  })
  it('fails closed on missing tokens, replay, malformed response, timeout and non-2xx', async () => {
    for (const token of ['', undefined, 'x'.repeat(2049)])
      await expect(
        verifyTurnstileResult(
          'test-secret',
          token,
          'login',
          'shop.example',
          verifier({ success: true }),
        ),
      ).rejects.toThrow()
    await expect(
      verifyTurnstileResult(
        'test-secret',
        'replay',
        'login',
        'shop.example',
        verifier({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
      ),
    ).rejects.toThrow()
    await expect(
      verifyTurnstileResult(
        'test-secret',
        'test-token',
        'login',
        'shop.example',
        verifier({}, 503),
      ),
    ).rejects.toThrow()
    await expect(
      verifyTurnstileResult('test-secret', 'test-token', 'login', 'shop.example', async () => {
        throw new Error('timeout')
      }),
    ).rejects.toThrow()
    await expect(
      verifyTurnstileResult(
        'test-secret',
        'test-token',
        'login',
        'shop.example',
        async () => new Response('invalid json'),
      ),
    ).rejects.toThrow()
  })
})
