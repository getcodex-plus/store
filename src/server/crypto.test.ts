import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from './crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
describe('secret storage', () => {
  it('randomizes ciphertext and rejects tampering and cross-purpose substitution', () => {
    const first = encrypt('sensitive-value', 'totp:user-a'),
      second = encrypt('sensitive-value', 'totp:user-a')
    expect(first).not.toBe(second)
    expect(first).not.toContain('sensitive-value')
    expect(decrypt(first, 'totp:user-a')).toBe('sensitive-value')
    expect(() => decrypt(first, 'totp:user-b')).toThrow()
    const modified = Buffer.from(first, 'base64')
    modified[20] ^= 0xff
    expect(() => decrypt(modified.toString('base64'), 'totp:user-a')).toThrow()
  })
  it('stores salted password hashes and verifies only the original password', async () => {
    const a = await hashPassword('a-test-password-1234'),
      b = await hashPassword('a-test-password-1234')
    expect(a).not.toBe(b)
    expect(a).not.toContain('a-test-password')
    expect(await verifyPassword({ password: 'a-test-password-1234', hash: a })).toBe(true)
    expect(await verifyPassword({ password: 'incorrect', hash: a })).toBe(false)
  })
})
