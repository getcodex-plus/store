import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  canonical,
  decimalToMinor,
  epayV1Signature,
  epayV2Signature,
  epayV2Verify,
  gmpaySignature,
  safeEqual,
  xorpaySignature,
} from './signatures'
import { verifyReceipt } from './payments'
describe('payment protocol boundaries', () => {
  it('canonicalizes values without encoding, removes empty and signature fields', () => {
    expect(
      canonical({ z: '中 文', a: '1', empty: '', nil: null, sign: 'x', sign_type: 'RSA' }, [
        'sign',
        'sign_type',
      ]),
    ).toBe('a=1&z=中 文')
  })
  it('uses exact decimal minor units and rejects malformed amounts', () => {
    expect(decimalToMinor('129.00')).toBe(12900)
    expect(decimalToMinor('0.01')).toBe(1)
    for (const bad of ['-1', '1e2', '1.001', 'Infinity', 'NaN', ' 1', '1.', '900719925474099100'])
      expect(() => decimalToMinor(bad)).toThrow()
  })
  it('rejects unequal signatures including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })
  it('verifies XorPay amount-bound signatures and rejects a modified amount', () => {
    const f = {
      aoid: 'trade-1',
      order_id: 'order-1',
      pay_price: '129.00',
      pay_time: '2026-11-13 12:00:00',
      sign: '',
    }
    f.sign = xorpaySignature([f.aoid, f.order_id, f.pay_price, f.pay_time], 'test-only')
    expect(verifyReceipt('xorpay', f, { secret: 'test-only' }).amount).toBe(12900)
    expect(() =>
      verifyReceipt('xorpay', { ...f, pay_price: '1.00' }, { secret: 'test-only' }),
    ).toThrow()
  })
  it('binds EPay v1 callbacks to the merchant and excludes pending payment states', () => {
    const f = {
      pid: '42',
      out_trade_no: 'o_1',
      trade_no: 't_1',
      money: '129.00',
      type: 'alipay',
      trade_status: 'TRADE_SUCCESS',
      sign_type: 'MD5',
      sign: '',
    }
    f.sign = epayV1Signature(f, 'test-only')
    expect(verifyReceipt('epay_v1', f, { pid: '42', key: 'test-only' }).paid).toBe(true)
    expect(() => verifyReceipt('epay_v1', f, { pid: '43', key: 'test-only' })).toThrow()
    const pending = { ...f, trade_status: 'WAIT_BUYER_PAY' }
    pending.sign = epayV1Signature(pending, 'test-only')
    expect(verifyReceipt('epay_v1', pending, { pid: '42', key: 'test-only' }).paid).toBe(false)
  })
  it('verifies EPay v2 RSA-SHA256 and rejects downgrade, field tampering, and wrong keys', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const f = {
      pid: '42',
      out_trade_no: 'o_1',
      trade_no: 't_1',
      money: '129.00',
      type: 'alipay',
      trade_status: 'TRADE_SUCCESS',
      timestamp: '1794560000',
      sign_type: 'RSA',
      sign: '',
    }
    f.sign = epayV2Signature(f, privateKey)
    expect(epayV2Verify(f, publicKey)).toBe(true)
    expect(verifyReceipt('epay_v2', f, { pid: '42', publicKey }).paid).toBe(true)
    expect(epayV2Verify({ ...f, money: '130.00' }, publicKey)).toBe(false)
    expect(() =>
      verifyReceipt('epay_v2', { ...f, sign_type: 'MD5' }, { pid: '42', publicKey }),
    ).toThrow()
    expect(epayV2Verify(f, 'invalid-key')).toBe(false)
  })
  it('handles the authoritative GMPay callback without a currency field', () => {
    const f = {
      pid: '42',
      order_id: 'order-1',
      trade_id: '26071406211234567890',
      amount: '129.00',
      actual_amount: '18.12',
      token: 'USDT',
      status: '2',
      signature: '',
    }
    f.signature = gmpaySignature(f, 'test-only')
    expect(verifyReceipt('gmpay', f, { pid: '42', secret: 'test-only' }).amount).toBe(12900)
    expect(() => gmpaySignature({ url: 'https://example.test/?a=1&b=2' }, 'test-only')).toThrow(
      'Ambiguous',
    )
    expect(() =>
      verifyReceipt('gmpay', { ...f, status: '1' }, { pid: '42', secret: 'test-only' }),
    ).toThrow()
  })
})
