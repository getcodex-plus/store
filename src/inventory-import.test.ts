import { describe, expect, it } from 'vitest'
import { parseAicdkCSV, parseInventoryText } from './inventory-import'

describe('AICDK inventory import', () => {
  it('reads actual single-code-column exports, BOM, CRLF and quoted cells', () => {
    expect(parseAicdkCSV('\uFEFFcode\r\n"BRAND,ONE"\r\n"BRAND""TWO"\r\n')).toEqual([
      'BRAND,ONE',
      'BRAND"TWO',
    ])
    expect(parseAicdkCSV('code\n12345678')).toEqual(['12345678'])
  })
  it.each([
    'wrong\n12345678',
    'code,session\n12345678,secret',
    'code\n"unclosed',
    'code\n"12345678"x',
    'code\n12345678,',
    'code\n\n12345678',
    'code\nshort',
    'code\n"1234\n5678"',
    'code\n',
  ])('rejects malformed files without putting codes into errors: %s', (text) => {
    expect(() => parseAicdkCSV(text)).toThrow()
  })
  it('retains duplicates for server-side canonical fingerprint accounting', () => {
    expect(parseAicdkCSV('code\n12345678\n12345678\n')).toEqual(['12345678', '12345678'])
  })
  it('limits imports and file size', () => {
    expect(() => parseAicdkCSV(`code\n${'12345678\n'.repeat(501)}`)).toThrow('500')
    expect(() => parseAicdkCSV('a'.repeat(256 * 1024 + 1))).toThrow('256 KB')
    expect(parseInventoryText('  12345678 \r\n\n ABCDEFGH ')).toEqual(['12345678', 'ABCDEFGH'])
    expect(() => parseInventoryText('')).toThrow('至少')
  })
})
