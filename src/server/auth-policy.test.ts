import { describe, it, expect } from 'vitest'
import { permittedSession } from './better-auth'
describe('login assurance policy', () => {
  it('requires MFA for password/email after TOTP enrollment, but permits Passkey directly', () => {
    for (const method of ['password', 'email', 'unknown'])
      expect(permittedSession(method, true, true)).toBe(false)
    expect(permittedSession('passkey', true, true)).toBe(true)
    expect(permittedSession('mfa', true, true)).toBe(true)
  })
  it('rejects password-only sessions with Passkey but permits completed MFA', () => {
    expect(permittedSession('password', true, false)).toBe(false)
    expect(permittedSession('email', true, false)).toBe(true)
    expect(permittedSession('mfa', true, false)).toBe(true)
    expect(permittedSession('password', false, true)).toBe(false)
    expect(permittedSession('email', false, true)).toBe(false)
    expect(permittedSession('mfa', false, true)).toBe(true)
    expect(permittedSession('password', false, false)).toBe(true)
    expect(permittedSession('unknown', false, false)).toBe(false)
  })
  it('keeps email available with email-only two-step verification and protects password login', () => {
    for (const hasPasskey of [true, false]) {
      expect(permittedSession('password', hasPasskey, true, false)).toBe(false)
      expect(permittedSession('email', hasPasskey, true, false)).toBe(true)
      expect(permittedSession('mfa', hasPasskey, true, false)).toBe(true)
      expect(permittedSession('unknown', hasPasskey, true, false)).toBe(false)
    }
  })
})
