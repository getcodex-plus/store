import { it, expect } from 'vitest'
import { parseSession, demoSession, normalizeDemoSession } from './lib'
it('requires a complete session rather than accepting an email alone', () => {
  expect(() => parseSession('not json')).toThrow()
  expect(() =>
    parseSession(JSON.stringify({ user: { email: 'a@example.com' }, accessToken: 'x' })),
  ).toThrow('sessionToken')
  expect(
    parseSession(
      JSON.stringify({ user: { email: 'a@example.com' }, accessToken: 'x', sessionToken: 'y' }),
    ).user.email,
  ).toBe('a@example.com')
})
it('uses the same session shape in demo and strips extra fields before submission', () => {
  const sample = JSON.parse(demoSession('buyer@example.com'))
  expect(parseSession(JSON.stringify(sample)).user.email).toBe('buyer@example.com')
  expect(
    JSON.parse(
      normalizeDemoSession(
        JSON.stringify({
          ...sample,
          extra: 'not-for-transmission',
          user: { ...sample.user, private: 'discard' },
        }),
      ),
    ),
  ).toEqual(sample)
  expect(() =>
    normalizeDemoSession(JSON.stringify({ ...sample, accessToken: 'not-a-real-token' })),
  ).toThrow('示例 Session')
  expect(() => normalizeDemoSession('not json')).toThrow('JSON')
  expect(() => normalizeDemoSession(JSON.stringify({ user: sample.user }))).toThrow('不完整')
})
