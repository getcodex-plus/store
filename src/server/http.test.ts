import { describe, it, expect } from 'vitest'
import { parseFlatCallbackJSON } from './http'
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
