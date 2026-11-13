import { describe, expect, it } from 'vitest'
import { classifySource, funnelSchema } from './funnel'
describe('minimal funnel input', () => {
  it('rejects forged financial events and arbitrary payloads', () => {
    expect(
      funnelSchema.safeParse({ event: 'payment_succeeded', productId: 'plus', source: 'direct' })
        .success,
    ).toBe(false)
    expect(
      funnelSchema.safeParse({
        event: 'plan_view',
        productId: 'plus',
        source: 'direct',
        session: 'secret',
      }).success,
    ).toBe(false)
    expect(
      funnelSchema.safeParse({ event: 'plan_view', productId: 'plus', source: 'buyer@example.com' })
        .success,
    ).toBe(false)
  })
  it('classifies sources without returning raw queries, referrals or identifiers', () => {
    const origin = 'https://shop.example'
    expect(classifySource('?ref=abcdef1234', '', origin)).toBe('referral')
    expect(classifySource('?utm_source=google&utm_term=private', '', origin)).toBe('google')
    expect(classifySource('?utm_source=person@example.com', '', origin)).toBe('other')
    expect(classifySource('', 'https://www.google.com/search?q=private', origin)).toBe('google')
    expect(classifySource('', 'https://www.google.com.evil.test/', origin)).toBe('other')
    expect(classifySource('', `${origin}/checkout?product=plus`, origin)).toBe('direct')
  })
})
