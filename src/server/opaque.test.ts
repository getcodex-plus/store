import { prepareTestDatabase, cleanupTestDatabase, testQuery } from './database-test-support'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, ready } from '@serenity-kit/opaque'

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_opaque_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.APP_URL = 'http://localhost:3000'
})
import { auth } from './better-auth'
import { Prisma } from './db'
import { decrypt, hash, id } from './crypto'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const secret = 'synthetic-opaque-test-password'
const nextSecret = 'synthetic-replacement-password'

class Browser {
  cookies = new Map([['getgpt_browser', id()]])
  async request(path: string, body?: object) {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    )
    for (const cookie of response.headers.getSetCookie()) {
      const [key, ...value] = cookie.split(';')[0].split('=')
      this.cookies.set(key, value.join('='))
    }
    return response
  }
  async emailLogin(email: string) {
    expect(
      (await this.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status,
    ).toBe(200)
    const row = (
      await testQuery(
        Prisma.sql`SELECT code FROM demo_mailbox WHERE browser_digest=${hash(this.cookies.get('getgpt_browser')!)} AND email=${email}`,
      )
    ).rows[0]
    expect(
      (await this.request('/sign-in/email-otp', { email, otp: decrypt(row.code, 'demo-email') }))
        .status,
    ).toBe(200)
  }
}

async function prepareLogin(browser: Browser, email: string, password = secret) {
  const start = client.startLogin({ password })
  const response = await browser.request('/sign-in/opaque/challenge', {
    email,
    loginRequest: start.startLoginRequest,
  })
  expect(response.status).toBe(200)
  const { challenge, state } = await response.json()
  const result = client.finishLogin({
    password,
    clientLoginState: start.clientLoginState,
    loginResponse: challenge,
  })
  return { email, loginResult: result?.finishLoginRequest, encryptedServerState: state }
}

async function prepareEnrollment(browser: Browser, password = secret) {
  const start = client.startRegistration({ password })
  const response = await browser.request('/opaque/enroll/challenge', {
    registrationRequest: start.registrationRequest,
  })
  expect(response.status).toBe(200)
  const { challenge, state } = await response.json()
  const { registrationRecord } = client.finishRegistration({
    password,
    clientRegistrationState: start.clientRegistrationState,
    registrationResponse: challenge,
  })
  return { registrationRecord, state }
}

async function prepareChange(browser: Browser) {
  const login = client.startLogin({ password: secret })
  const registration = client.startRegistration({ password: nextSecret })
  const response = await browser.request('/opaque/changePassword/challenge', {
    loginRequest: login.startLoginRequest,
    registrationRequest: registration.registrationRequest,
  })
  expect(response.status).toBe(200)
  const { loginChallenge, registrationChallenge, state } = await response.json()
  const proof = client.finishLogin({
    password: secret,
    clientLoginState: login.clientLoginState,
    loginResponse: loginChallenge,
  })!
  const { registrationRecord } = client.finishRegistration({
    password: nextSecret,
    clientRegistrationState: registration.clientRegistrationState,
    registrationResponse: registrationChallenge,
  })
  return { loginResult: proof.finishLoginRequest, registrationRecord, encryptedServerState: state }
}

suite('OPAQUE authentication against PostgreSQL', () => {
  const users: string[] = []
  async function fixture(enroll = true) {
    const email = `${id('opaque-')}@example.com`
    users.push(email)
    const browser = new Browser()
    await browser.emailLogin(email)
    if (enroll) {
      const response = await browser.request(
        '/opaque/enroll/complete',
        await prepareEnrollment(browser),
      )
      expect(response.status, await response.clone().text()).toBe(200)
    }
    const userId = (await testQuery(Prisma.sql`SELECT id FROM users WHERE email=${email}`)).rows[0]
      .id as string
    return { email, browser, userId }
  }
  beforeAll(async () => {
    if (!new URL(process.env.TEST_DATABASE_URL!).pathname.endsWith('_test'))
      throw new Error('OPAQUE integration tests require a dedicated database ending in _test')
    await ready
    await prepareTestDatabase()
  }, 30_000)
  beforeEach(async () => {
    await testQuery(Prisma.sql`DELETE FROM auth_rate_limit`)
  })
  afterAll(async () => {
    await testQuery(Prisma.sql`DELETE FROM users WHERE email=ANY(${users})`)
    await cleanupTestDatabase()
  })

  it('stores only an OPAQUE record and does not return it in account responses', async () => {
    const { userId, browser } = await fixture()
    const rows = (
      await testQuery(
        Prisma.sql`SELECT "providerId",password,"registrationRecord" FROM auth_account WHERE "userId"=${userId}`,
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].providerId).toBe('opaque')
    expect(rows[0].password).toBeNull()
    expect(Buffer.from(rows[0].registrationRecord, 'base64url')).toHaveLength(192)
    expect(JSON.stringify(rows)).not.toContain(secret)
    const accounts = await browser.request('/list-accounts')
    expect(accounts.status).toBe(200)
    expect(await accounts.text()).not.toContain(rows[0].registrationRecord)
  })

  it('rejects wrong passwords, unknown accounts, plaintext routes and proof replay', async () => {
    const { email } = await fixture()
    const browser = new Browser()
    expect((await prepareLogin(browser, email, 'incorrect')).loginResult).toBeUndefined()
    expect((await prepareLogin(browser, `${id()}@example.com`)).loginResult).toBeUndefined()
    for (const path of ['/sign-in/email', '/sign-up/email', '/change-password', '/reset-password'])
      expect((await browser.request(path, { email, password: secret })).status).toBe(403)
    expect((await browser.request('/sign-up/opaque/complete', {})).status).toBe(404)
    const payload = await prepareLogin(browser, email)
    expect((await browser.request('/sign-in/opaque/complete', payload)).status).toBe(200)
    expect((await browser.request('/get-session')).status).toBe(200)
    expect((await browser.request('/sign-in/opaque/complete', payload)).status).toBe(401)
  })

  it('atomically consumes concurrent login proofs and enrollment attempts', async () => {
    const { browser, email } = await fixture(false)
    const enrollment = await prepareEnrollment(browser)
    const enrollments = await Promise.all([
      browser.request('/opaque/enroll/complete', enrollment),
      browser.request('/opaque/enroll/complete', enrollment),
    ])
    expect(enrollments.map((r) => r.status).sort()).toEqual([200, 401])
    const payload = await prepareLogin(new Browser(), email)
    const responses = await Promise.all([
      new Browser().request('/sign-in/opaque/complete', payload),
      new Browser().request('/sign-in/opaque/complete', payload),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401])
  })

  it('changes passwords, revokes other sessions and rejects outstanding old credentials', async () => {
    const { browser, email } = await fixture()
    const other = new Browser()
    expect(
      (await other.request('/sign-in/opaque/complete', await prepareLogin(other, email))).status,
    ).toBe(200)
    const outstanding = await prepareLogin(new Browser(), email)
    const change = await prepareChange(browser)
    expect((await browser.request('/opaque/changePassword/complete', change)).status).toBe(200)
    expect(await (await other.request('/get-session')).json()).toBeNull()
    expect(await (await browser.request('/get-session')).json()).not.toBeNull()
    expect((await new Browser().request('/sign-in/opaque/complete', outstanding)).status).toBe(401)
    expect((await prepareLogin(new Browser(), email)).loginResult).toBeUndefined()
    const fresh = new Browser()
    expect(
      (
        await fresh.request(
          '/sign-in/opaque/complete',
          await prepareLogin(fresh, email, nextSecret),
        )
      ).status,
    ).toBe(200)
    expect((await browser.request('/opaque/changePassword/complete', change)).status).toBe(401)
  })

  it('binds proofs to their purpose, user, session and expiration', async () => {
    const { browser, email } = await fixture()
    const change = await prepareChange(browser)
    expect(
      (await new Browser().request('/sign-in/opaque/complete', { ...change, email })).status,
    ).toBe(401)
    const other = new Browser()
    await other.emailLogin(email)
    const another = await prepareChange(browser)
    expect((await other.request('/opaque/changePassword/complete', another)).status).toBe(401)
    const expired = await prepareLogin(new Browser(), email)
    await testQuery(
      Prisma.sql`UPDATE auth_verification SET "expiresAt"=now()-interval '1 second' WHERE identifier=${`opaque:${hash(expired.encryptedServerState)}`}`,
    )
    expect((await new Browser().request('/sign-in/opaque/complete', expired)).status).toBe(401)
    const swapped = await prepareLogin(new Browser(), email)
    expect(
      (
        await new Browser().request('/sign-in/opaque/complete', {
          ...swapped,
          email: 'another@example.com',
        })
      ).status,
    ).toBe(401)
  })

  it('uses current MFA state at completion and grants no session before the second factor', async () => {
    const { email, userId } = await fixture()
    const browser = new Browser()
    const payload = await prepareLogin(browser, email)
    await testQuery(Prisma.sql`UPDATE users SET two_factor_enabled=true WHERE id=${userId}`)
    const result = await browser.request('/sign-in/opaque/complete', payload)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      twoFactorRedirect: true,
      twoFactorMethods: ['otp'],
    })
    expect(await (await browser.request('/get-session')).json()).toBeNull()
    expect((await browser.request('/two-factor/send-otp', {})).status).toBe(200)
    const row = (
      await testQuery(
        Prisma.sql`SELECT code FROM demo_mailbox WHERE browser_digest=${hash(browser.cookies.get('getgpt_browser')!)} AND email=${email}`,
      )
    ).rows[0]
    expect(
      (await browser.request('/two-factor/verify-otp', { code: decrypt(row.code, 'demo-email') }))
        .status,
    ).toBe(200)
    expect((await (await browser.request('/get-session')).json()).session.method).toBe('mfa')
  })

  it('rejects disabled users and stale sessions at completion', async () => {
    const { browser, email, userId } = await fixture()
    const payload = await prepareLogin(new Browser(), email)
    await testQuery(Prisma.sql`UPDATE users SET disabled=true WHERE id=${userId}`)
    expect((await new Browser().request('/sign-in/opaque/complete', payload)).status).toBe(401)
    await testQuery(Prisma.sql`UPDATE users SET disabled=false WHERE id=${userId}`)
    const change = await prepareChange(browser)
    await testQuery(
      Prisma.sql`UPDATE auth_session SET "createdAt"=now()-interval '11 minutes' WHERE "userId"=${userId}`,
    )
    expect((await browser.request('/opaque/changePassword/complete', change)).status).toBe(403)
  })
})
