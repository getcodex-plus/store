import { prepareTestDatabase, cleanupTestDatabase, testQuery } from './database-test-support'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, ready } from '@serenity-kit/opaque'
import { URI } from 'otpauth'

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
  async request(path: string, body?: object, headers?: Record<string, string>) {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...headers,
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
  async emailCode(email: string) {
    expect(
      (await this.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status,
    ).toBe(200)
    const row = (
      await testQuery(
        Prisma.sql`SELECT code FROM demo_mailbox WHERE browser_digest=${hash(this.cookies.get('getgpt_browser')!)} AND email=${email}`,
      )
    ).rows[0]
    return decrypt(row.code, 'demo-email')
  }
  async emailLogin(email: string) {
    const response = await this.request('/sign-in/email-otp', {
      email,
      otp: await this.emailCode(email),
    })
    expect(response.status).toBe(200)
    return response.json()
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
  return prepareRegistration(browser, 'enroll', password)
}

async function prepareReset(browser: Browser) {
  return prepareRegistration(browser, 'resetPassword', nextSecret)
}

async function prepareRegistration(browser: Browser, operation: string, password: string) {
  const start = client.startRegistration({ password })
  const response = await browser.request(`/opaque/${operation}/challenge`, {
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

  it('resets with email verification without the old password and revokes every session and old challenge', async () => {
    const { browser, email, userId } = await fixture()
    const other = new Browser()
    await other.emailLogin(email)
    const outstanding = await prepareLogin(new Browser(), email)
    const reset = await prepareReset(browser)
    expect((await browser.request('/opaque/resetPassword/complete', reset)).status).toBe(200)
    expect(await (await browser.request('/get-session')).json()).toBeNull()
    expect(await (await other.request('/get-session')).json()).toBeNull()
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
    const accounts = (
      await testQuery(
        Prisma.sql`SELECT "providerId",password FROM auth_account WHERE "userId"=${userId}`,
      )
    ).rows
    expect(accounts).toEqual([{ providerId: 'opaque', password: null }])
  })

  it('requires a recent independent verification and rejects password-only and unauthenticated sessions', async () => {
    const { browser, email, userId } = await fixture()
    const registration = client.startRegistration({ password: nextSecret })
    const body = { registrationRequest: registration.registrationRequest }
    const other = new Browser()
    expect((await other.request('/opaque/resetPassword/challenge', body)).status).toBe(403)
    await other.request('/sign-in/opaque/complete', await prepareLogin(other, email))
    expect((await other.request('/opaque/resetPassword/challenge', body)).status).toBe(403)
    const reset = await prepareReset(browser)
    expect((await other.request('/opaque/resetPassword/complete', reset)).status).toBe(401)
    const stale = await prepareReset(browser)
    await testQuery(
      Prisma.sql`UPDATE auth_session SET "createdAt"=now()-interval '11 minutes' WHERE "userId"=${userId}`,
    )
    expect((await browser.request('/opaque/resetPassword/challenge', body)).status).toBe(403)
    expect((await browser.request('/opaque/resetPassword/complete', stale)).status).toBe(403)
  })

  it('binds reset tickets to purpose, session and expiration and rejects replay', async () => {
    const { browser, email } = await fixture()
    const wrongPurpose = await prepareReset(browser)
    expect((await browser.request('/opaque/enroll/complete', wrongPurpose)).status).toBe(401)
    const other = new Browser()
    await other.emailLogin(email)
    expect(
      (await other.request('/opaque/resetPassword/complete', await prepareReset(browser))).status,
    ).toBe(401)
    const expired = await prepareReset(browser)
    await testQuery(
      Prisma.sql`UPDATE auth_verification SET "expiresAt"=now()-interval '1 second' WHERE identifier=${`opaque:${hash(expired.state)}`}`,
    )
    expect((await browser.request('/opaque/resetPassword/complete', expired)).status).toBe(401)
    const reset = await prepareReset(browser)
    const statuses = await Promise.all([
      browser.request('/opaque/resetPassword/complete', reset),
      browser.request('/opaque/resetPassword/complete', reset),
    ])
    expect(statuses.map((response) => response.status).sort()).toEqual([200, 401])
    await browser.emailLogin(email)
    expect((await browser.request('/opaque/resetPassword/complete', reset)).status).toBe(401)
  })

  it('rechecks disabled users, credential versions and session assurance at reset completion', async () => {
    const { browser, userId, email } = await fixture()
    const disabled = await prepareReset(browser)
    await testQuery(Prisma.sql`UPDATE users SET disabled=true WHERE id=${userId}`)
    expect((await browser.request('/opaque/resetPassword/complete', disabled)).status).toBe(403)
    await testQuery(Prisma.sql`UPDATE users SET disabled=false WHERE id=${userId}`)
    const downgraded = await prepareReset(browser)
    await testQuery(Prisma.sql`UPDATE auth_session SET method='password' WHERE "userId"=${userId}`)
    expect((await browser.request('/opaque/resetPassword/complete', downgraded)).status).toBe(403)
    await browser.emailLogin(email)
    const changed = await prepareReset(browser)
    expect(
      (await browser.request('/opaque/changePassword/complete', await prepareChange(browser)))
        .status,
    ).toBe(200)
    expect((await browser.request('/opaque/resetPassword/complete', changed)).status).toBe(401)
  })

  it('rejects cross-account reset tickets and cross-origin reset requests', async () => {
    const { browser } = await fixture()
    const { browser: other } = await fixture()
    expect(
      (await other.request('/opaque/resetPassword/complete', await prepareReset(browser))).status,
    ).toBe(401)
    const reset = await prepareReset(browser)
    expect(
      (
        await browser.request('/opaque/resetPassword/complete', reset, {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403)
    expect((await browser.request('/opaque/resetPassword/complete', reset)).status).toBe(200)
  })

  it('keeps MFA required before and after a password reset', async () => {
    const { browser, email, userId } = await fixture()
    expect((await browser.request('/two-factor/enable', { method: 'otp' })).status).toBe(200)
    const setup = await browser.request('/two-factor/enable', {})
    expect(setup.status).toBe(200)
    const totp = URI.parse((await setup.json()).totpURI)
    expect(
      (await browser.request('/two-factor/verify-totp', { code: totp.generate() })).status,
    ).toBe(200)
    const recovery = new Browser()
    expect(await recovery.emailLogin(email)).toMatchObject({ twoFactorRedirect: true })
    expect(await (await recovery.request('/get-session')).json()).toBeNull()
    const request = {
      registrationRequest: client.startRegistration({ password: nextSecret }).registrationRequest,
    }
    expect((await recovery.request('/opaque/resetPassword/challenge', request)).status).toBe(403)
    expect((await recovery.request('/two-factor/verify-totp', { code: 'invalid' })).ok).toBe(false)
    expect((await recovery.request('/opaque/resetPassword/challenge', request)).status).toBe(403)
    expect(
      (await recovery.request('/two-factor/verify-totp', { code: totp.generate() })).status,
    ).toBe(200)
    expect(
      (await recovery.request('/opaque/resetPassword/complete', await prepareReset(recovery)))
        .status,
    ).toBe(200)
    expect(
      (await testQuery(Prisma.sql`SELECT two_factor_enabled FROM users WHERE id=${userId}`)).rows[0]
        .two_factor_enabled,
    ).toBe(true)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT id FROM "twoFactor" WHERE "userId"=${userId} AND verified=true`,
        )
      ).rows,
    ).toHaveLength(1)
    const fresh = new Browser()
    const login = await fresh.request(
      '/sign-in/opaque/complete',
      await prepareLogin(fresh, email, nextSecret),
    )
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true })
    expect(await (await fresh.request('/get-session')).json()).toBeNull()
  })

  it('does not silently register an unknown email during recovery and consumes the email OTP', async () => {
    const email = `${id('recovery-')}@example.com`
    const browser = new Browser()
    const otp = await browser.emailCode(email)
    const headers = { 'x-getgpt-recovery': '1' }
    const result = await browser.request('/sign-in/email-otp', { email, otp }, headers)
    expect(result.status).toBe(400)
    expect(await result.json()).toMatchObject({
      message: '此邮箱尚未注册，请返回登录页面使用邮箱验证码注册',
    })
    expect(
      (await testQuery(Prisma.sql`SELECT id FROM users WHERE email=${email}`)).rows,
    ).toHaveLength(0)
    expect((await browser.request('/sign-in/email-otp', { email, otp }, headers)).ok).toBe(false)
  })

  it('does not use reset to create a credential for an account without a password', async () => {
    const { browser } = await fixture(false)
    const response = await browser.request('/opaque/resetPassword/challenge', {
      registrationRequest: client.startRegistration({ password: nextSecret }).registrationRequest,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      message: '此账号尚未设置密码，请在账号安全页面设置登录密码',
    })
  })
})
