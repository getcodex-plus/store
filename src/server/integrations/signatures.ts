import { createHash, createHmac, createSign, createVerify, timingSafeEqual } from 'node:crypto'
type Fields = Record<string, string | number | null | undefined>
export function canonical(fields: Fields, exclude: string[]) {
  return Object.entries(fields)
    .filter(([key, value]) => !exclude.includes(key) && value != null && value !== '')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}
export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
export const md5 = (value: string) => createHash('md5').update(value).digest('hex')
export function xorpaySignature(values: string[], secret: string) {
  return md5(values.join('') + secret)
}
export function gmpaySignature(fields: Fields, secret: string) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'signature' || value == null || value === '') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value)))
      throw new Error('Ambiguous GMPay signature parameters')
  }
  return createHmac('sha256', secret)
    .update(canonical(fields, ['signature']))
    .digest('hex')
}
function epayCanonical(fields: Fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (['sign', 'sign_type'].includes(key) || value == null || value === '') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value)))
      throw new Error('Ambiguous EPay signature parameters')
  }
  return canonical(fields, ['sign', 'sign_type'])
}
export function epayV1Signature(fields: Fields, secret: string) {
  return md5(epayCanonical(fields) + secret)
}
export function epayV2Signature(fields: Fields, privateKey: string) {
  return createSign('RSA-SHA256').update(epayCanonical(fields)).sign(privateKey, 'base64')
}
export function epayV2Verify(fields: Fields, publicKey: string) {
  try {
    return createVerify('RSA-SHA256')
      .update(epayCanonical(fields))
      .verify(publicKey, String(fields.sign || ''), 'base64')
  } catch {
    return false
  }
}
export function decimalToMinor(input: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) throw new Error('Invalid money')
  const [whole, fraction = ''] = input.split('.')
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(value)) throw new Error('Invalid money')
  return value
}
