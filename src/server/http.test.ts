import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { failure, parseFlatCallbackJSON } from './http'
import { UpstreamError } from './integrations/aicdk'
describe('callback parser', () => {
  it('rejects duplicate fields including escaped key aliases', () => {
    expect(() => parseFlatCallbackJSON('{"amount":"1.00","amount":"100.00"}')).toThrow('重复')
    expect(() => parseFlatCallbackJSON('{"pid":"1","\\u0070id":"2"}')).toThrow('重复')
  })
  it('preserves scalar strings and normalizes JSON numbers as required by GMPay', () => {
    expect({
      ...parseFlatCallbackJSON('{"amount":"12.50","status":2,"extra":null,"name":"a, \\"b\\""}'),
    }).toEqual({ amount: '12.50', status: '2', extra: '', name: 'a, "b"' })
  })
  it('rejects nested structures, trailing garbage and invalid tokens', () => {
    for (const input of [
      '{"a":{}}',
      '{"a":[]}',
      '{"a":true}',
      '{"a":1,}',
      '{"a":1}garbage',
      '{"a":1e999}',
      '[]',
    ])
      expect(() => parseFlatCallbackJSON(input)).toThrow()
  })
})
it('never reflects provider payloads, validation input or arbitrary exception names', async () => {
  const secret = 'fixture-private-card-material'
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const unexpected = new Error(secret)
    unexpected.name = secret
    const invalid = z
      .string()
      .refine(() => false, secret)
      .safeParse(secret)
    for (const error of [
      new UpstreamError(secret, NaN, true),
      unexpected,
      invalid.error,
      new SyntaxError(secret),
    ]) {
      const response = failure(error)
      expect(await response.text()).not.toContain(secret)
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  } finally {
    log.mockRestore()
  }
})
