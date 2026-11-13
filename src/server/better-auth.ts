import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware, APIError, getSessionFromCtx } from 'better-auth/api'
import { emailOTP, twoFactor } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from './db'
import { appUrl, demo, validateRuntime } from './config'
import { encrypt, hash, id } from './crypto'
import { rateLimit } from './rate-limit'
import { requireTurnstile } from './turnstile'
import { sendLoginEmail } from './integrations/email'

function authSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET
  if (!demo) throw new Error('BETTER_AUTH_SECRET is required in live mode')
  const file = resolve('.data/auth.key')
  mkdirSync(resolve('.data'), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(file, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readFileSync(file, 'utf8')
}

// Extend the official plugin's challenge flow to email OTP; never issue our own MFA tokens.
// Covered by integration tests because upstream hook contracts may change on upgrades.
const mfa = twoFactor({
  schema: { user: { fields: { twoFactorEnabled: 'two_factor_enabled' } } },
  issuer: 'GetGPT',
  allowPasswordless: true,
  backupCodeOptions: { storeBackupCodes: 'encrypted', amount: 0 },
  otpOptions: {
    storeOTP: 'hashed',
    period: 10,
    allowedAttempts: 5,
    sendOTP: async ({ user, otp }, ctx) => deliverAuthCode(user.email, otp, ctx?.headers),
  },
  twoFactorCookieMaxAge: 300,
})
// Disable recovery-code API routes as well as generation.
delete (mfa.endpoints as Partial<typeof mfa.endpoints>).verifyBackupCode
delete (mfa.endpoints as Partial<typeof mfa.endpoints>).generateBackupCodes
delete (mfa.endpoints as Partial<typeof mfa.endpoints>).viewBackupCodes
const mfaHook = mfa.hooks.after[0]
const mfaMatcher = mfaHook.matcher
mfaHook.matcher = (ctx) => ctx.path === '/sign-in/email-otp' || mfaMatcher(ctx)
const mfaHandler = mfaHook.handler
mfaHook.handler = createAuthMiddleware(async (ctx) => {
  // Email is already the primary verification in this flow. Without TOTP,
  // do not ask for a second code sent to the same mailbox.
  if (ctx.path === '/sign-in/email-otp') {
    const userId = ctx.context.newSession?.user.id
    if (
      !userId ||
      !(
        await pool.query('SELECT id FROM "twoFactor" WHERE "userId"=$1 AND verified=true', [userId])
      ).rowCount
    )
      return
  }
  const result = (await mfaHandler({ ...ctx, returnHeaders: true })) as unknown as {
    response: { twoFactorRedirect: boolean; twoFactorMethods: string[] } | undefined
    headers: Headers
  }
  result.headers.forEach((value, name) => {
    if (name !== 'set-cookie') ctx.setHeader(name, value)
  })
  for (const cookie of result.headers.getSetCookie())
    ctx.responseHeaders.append('set-cookie', cookie)
  return result.response
})

async function deliverAuthCode(email: string, otp: string, headers?: Headers) {
  await rateLimit(`email:${hash(email)}`, demo ? 100 : 3, 600)
  await rateLimit('email-global', demo ? 10000 : 1000, 600)
  if (demo) {
    const browser = headers?.get('cookie')?.match(/(?:^|;\s*)getgpt_browser=([^;]+)/)?.[1]
    if (!browser) throw new APIError('BAD_REQUEST', { message: '请刷新页面后重试' })
    await pool.query(
      "INSERT INTO demo_mailbox(browser_digest,email,code,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') ON CONFLICT(browser_digest,email) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at",
      [hash(browser), email, encrypt(otp, 'demo-email')],
    )
  } else await sendLoginEmail(email, otp, id())
}

export function permittedSession(
  method: string,
  hasPasskey: boolean,
  enabled: boolean,
  totp = enabled,
) {
  if (method === 'passkey' || method === 'mfa') return true
  if (totp) return false
  return method === 'email' || (method === 'password' && !hasPasskey && !enabled)
}

const sensitivePaths = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/change-password',
  '/update-user',
])
const policy: BetterAuthPlugin = {
  id: 'getgpt-login-policy',
  hooks: {
    before: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          validateRuntime()
          if (
            [
              '/email-otp/send-verification-otp',
              '/sign-in/email',
              '/sign-in/email-otp',
              '/passkey/verify-authentication',
              '/two-factor/verify-totp',
              '/two-factor/verify-otp',
            ].includes(ctx.path)
          ) {
            try {
              if (!ctx.path.startsWith('/two-factor/') || !(await getSessionFromCtx(ctx)))
                await requireTurnstile('login', ctx.headers?.get('x-turnstile-token'))
            } catch {
              throw new APIError('FORBIDDEN', { message: '请完成安全验证后重试' })
            }
          }
          if (ctx.body?.trustDevice)
            throw new APIError('BAD_REQUEST', { message: '请每次完成二步验证' })
          if (
            [
              '/sign-up/email',
              '/request-password-reset',
              '/reset-password',
              '/email-otp/reset-password',
              '/email-otp/request-password-reset',
            ].includes(ctx.path)
          )
            throw new APIError('FORBIDDEN', { message: '请通过邮箱验证码注册或登录后管理密码' })
          if (sensitivePaths.has(ctx.path)) {
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true })
            if (!session || Date.now() - new Date(session.session.createdAt).getTime() > 600000)
              throw new APIError('FORBIDDEN', {
                message: '请重新登录后执行此操作（需要最近 10 分钟内验证）',
              })
            const user = (
              await pool.query(
                'SELECT disabled,two_factor_enabled,EXISTS(SELECT 1 FROM "twoFactor" t WHERE t."userId"=users.id AND t.verified=true) AS has_totp,EXISTS(SELECT 1 FROM auth_passkey p WHERE p."userId"=users.id) AS passkey FROM users WHERE id=$1',
                [session.user.id],
              )
            ).rows[0]
            const method = (session.session as typeof session.session & { method: string }).method
            if (
              !user ||
              user.disabled ||
              !permittedSession(method, user.passkey, user.two_factor_enabled, user.has_totp)
            )
              throw new APIError('FORBIDDEN', { message: '请完成账号所需的二步验证后重新登录' })
            if (ctx.path === '/two-factor/disable' && user.passkey)
              throw new APIError('FORBIDDEN', { message: '请先移除所有 Passkey，再关闭二步验证' })
            if (
              ctx.path === '/two-factor/enable' &&
              ctx.body?.method !== 'otp' &&
              !user.two_factor_enabled
            )
              throw new APIError('FORBIDDEN', { message: '请先开启二步验证，再设置身份验证器' })
          }
        }),
      },
    ],
    after: [
      {
        matcher: (ctx) =>
          [
            '/passkey/verify-registration',
            '/two-factor/verify-totp',
            '/two-factor/verify-otp',
            '/two-factor/disable',
            '/change-password',
          ].includes(ctx.path || ''),
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.context.returned instanceof APIError) return
          const session = ctx.context.newSession || ctx.context.session
          if (
            session &&
            ['/two-factor/verify-totp', '/two-factor/verify-otp'].includes(ctx.path || '')
          )
            await pool.query('UPDATE auth_session SET method=$1 WHERE token=$2', [
              'mfa',
              session.session.token,
            ])
          if (session)
            await pool.query('DELETE FROM auth_session WHERE "userId"=$1 AND token<>$2', [
              session.user.id,
              session.session.token,
            ])
        }),
      },
    ],
  },
}

export const auth = betterAuth({
  appName: 'GetGPT',
  baseURL: appUrl,
  secret: authSecret(),
  database: pool,
  trustedOrigins: [appUrl],
  advanced: {
    cookiePrefix: 'getgpt',
    useSecureCookies: !demo,
    database: { generateId: () => id('a_') },
  },
  user: {
    modelName: 'users',
    fields: { createdAt: 'created_at', updatedAt: 'updated_at', emailVerified: 'email_verified' },
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
      referralCode: { type: 'string', required: false, input: false, fieldName: 'referral_code' },
      invitedBy: { type: 'string', required: false, input: false, fieldName: 'invited_by' },
      disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
    },
  },
  session: {
    modelName: 'auth_session',
    expiresIn: 7 * 86400,
    freshAge: 600,
    cookieCache: { enabled: false },
    additionalFields: {
      method: { type: 'string', required: false, input: false, defaultValue: 'unknown' },
    },
  },
  account: { modelName: 'auth_account', encryptOAuthTokens: true },
  verification: { modelName: 'auth_verification' },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'auth_rate_limit',
    window: 60,
    max: demo ? 300 : 60,
    customRules: demo
      ? {
          '/two-factor/*': { window: 10, max: 30 },
          '/sign-in/*': { window: 60, max: 100 },
          '/passkey/*': { window: 60, max: 100 },
        }
      : undefined,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const referral = ctx?.headers?.get('x-getgpt-referral')?.slice(0, 40)
          const inviter = referral
            ? (
                await pool.query(
                  'SELECT id FROM users WHERE referral_code=$1 AND email<>$2 AND disabled=false',
                  [referral, user.email],
                )
              ).rows[0]
            : null
          return {
            data: {
              ...user,
              name: user.name || user.email.split('@')[0],
              referralCode: id().slice(0, 12),
              invitedBy: inviter?.id ?? null,
              role:
                demo && user.email === (process.env.ADMIN_EMAIL || '').toLowerCase()
                  ? 'admin'
                  : 'user',
              disabled: false,
            },
          }
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          if (
            !(
              await pool.query('SELECT id FROM users WHERE id=$1 AND disabled=false', [
                session.userId,
              ])
            ).rowCount
          )
            return false
          const path = ctx?.path || ''
          const method =
            path === '/passkey/verify-authentication'
              ? 'passkey'
              : path.startsWith('/two-factor/verify-')
                ? 'mfa'
                : path === '/sign-in/email-otp'
                  ? 'email'
                  : path === '/sign-in/email'
                    ? 'password'
                    : (sensitivePaths.has(path)
                        ? (ctx?.context.session?.session as { method?: string } | undefined)?.method
                        : undefined) ||
                      (session as typeof session & { method?: string }).method ||
                      'unknown'
          return { data: { ...session, method } }
        },
      },
    },
  },
  plugins: [
    emailOTP({
      rateLimit: demo ? { window: 60, max: 100 } : { window: 60, max: 3 },
      storeOTP: 'hashed',
      allowedAttempts: 5,
      expiresIn: 600,
      async sendVerificationOTP({ email, otp }, ctx) {
        await deliverAuthCode(email, otp, ctx?.headers)
      },
    }),
    passkey({
      rpID: new URL(appUrl).hostname,
      rpName: 'GetGPT',
      origin: appUrl,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      schema: { passkey: { modelName: 'auth_passkey' } },
    }),
    mfa,
    policy,
  ],
})
