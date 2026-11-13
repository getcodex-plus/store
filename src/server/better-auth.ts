import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware, APIError, getSessionFromCtx } from 'better-auth/api'
import { emailOTP, twoFactor } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db } from './db'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { getCurrentAdapter } from '@better-auth/core/context'
import { databaseNow } from './database-sql'
import { appUrl, demo, validateRuntime } from './config'
import { encrypt, hash, id } from './crypto'
import { rateLimit } from './rate-limit'
import { requireTurnstile } from './turnstile'
import { sendLoginEmail } from './integrations/email'
import { opaqueAuth } from './opaque'

type AuthAdapter = Parameters<typeof getCurrentAdapter>[0]
async function hookAdapter(context?: { adapter: AuthAdapter }): Promise<AuthAdapter> {
  return getCurrentAdapter(context?.adapter ?? ((await auth.$context).adapter as AuthAdapter))
}

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
  issuer: 'GetCodex Plus',
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
mfaHook.matcher = (ctx) =>
  ctx.path === '/sign-in/email-otp' || ctx.path === '/sign-in/opaque/complete' || mfaMatcher(ctx)
const mfaHandler = mfaHook.handler
mfaHook.handler = createAuthMiddleware(async (ctx) => {
  // Email is already the primary verification in this flow. Without TOTP,
  // do not ask for a second code sent to the same mailbox.
  if (ctx.path === '/sign-in/email-otp') {
    const userId = ctx.context.newSession?.user.id
    if (!userId || !(await db.twoFactor.count({ where: { userId, verified: true } }))) return
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
    const browserDigest = hash(browser)
    const code = encrypt(otp, 'demo-email')
    const expiresAt = new Date((await databaseNow()).getTime() + 10 * 60_000)
    await db.demoMailbox.upsert({
      where: { browserDigest_email: { browserDigest, email } },
      create: { browserDigest, email, code, expiresAt },
      update: { code, expiresAt },
    })
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
  '/opaque/enroll/challenge',
  '/opaque/enroll/complete',
  '/opaque/changePassword/challenge',
  '/opaque/changePassword/complete',
  '/update-user',
])
const disabledPasswordPaths = new Set([
  '/sign-in/email',
  '/sign-up/email',
  '/change-password',
  '/set-password',
  '/verify-password',
  '/request-password-reset',
  '/reset-password',
  '/email-otp/reset-password',
  '/email-otp/request-password-reset',
])
const policy: BetterAuthPlugin = {
  id: 'getgpt-login-policy',
  hooks: {
    before: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          validateRuntime()
          if (disabledPasswordPaths.has(ctx.path))
            throw new APIError('FORBIDDEN', {
              message: '请使用密码登录，或通过邮箱验证码登录后设置密码',
            })
          if (
            ctx.path.startsWith('/two-factor/') &&
            ctx.body &&
            Object.hasOwn(ctx.body, 'password')
          )
            throw new APIError('BAD_REQUEST', { message: '请重新登录后管理二步验证，无需提交密码' })
          if (
            [
              '/email-otp/send-verification-otp',
              '/sign-in/opaque/challenge',
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
          if (sensitivePaths.has(ctx.path)) {
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true })
            if (!session || Date.now() - new Date(session.session.createdAt).getTime() > 600000)
              throw new APIError('FORBIDDEN', {
                message: '请重新登录后执行此操作（需要最近 10 分钟内验证）',
              })
            const user = await db.user.findUnique({
              where: { id: session.user.id },
              include: {
                twoFactors: { where: { verified: true }, select: { id: true } },
                passkeys: { select: { id: true } },
              },
            })
            const method = (session.session as typeof session.session & { method: string }).method
            if (
              !user ||
              user.disabled ||
              !permittedSession(
                method,
                user.passkeys.length > 0,
                !!user.twoFactorEnabled,
                user.twoFactors.length > 0,
              )
            )
              throw new APIError('FORBIDDEN', { message: '请完成账号所需的二步验证后重新登录' })
            if (ctx.path === '/two-factor/disable' && user.passkeys.length > 0)
              throw new APIError('FORBIDDEN', { message: '请先移除所有 Passkey，再关闭二步验证' })
            if (
              ctx.path === '/two-factor/enable' &&
              ctx.body?.method !== 'otp' &&
              !user.twoFactorEnabled
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
            '/two-factor/enable',
            '/two-factor/disable',
            '/opaque/enroll/complete',
            '/opaque/changePassword/complete',
          ].includes(ctx.path || ''),
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.context.returned instanceof APIError) return
          const session = ctx.context.newSession || ctx.context.session
          if (
            session &&
            ['/two-factor/verify-totp', '/two-factor/verify-otp'].includes(ctx.path || '')
          )
            await db.authSession.updateMany({
              where: { token: session.session.token },
              data: { method: 'mfa' },
            })
          if (session)
            await db.authSession.deleteMany({
              where: { userId: session.user.id, token: { not: session.session.token } },
            })
        }),
      },
    ],
  },
}

export const auth = betterAuth({
  appName: 'GetCodex Plus',
  baseURL: appUrl,
  secret: authSecret(),
  database: prismaAdapter(db, { provider: 'postgresql', transaction: true }),
  trustedOrigins: [appUrl],
  advanced: {
    cookiePrefix: 'getgpt',
    useSecureCookies: !demo,
    database: { generateId: () => id('a_') },
  },
  user: {
    modelName: 'user',
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
      referralCode: { type: 'string', required: false, input: false },
      invitedBy: { type: 'string', required: false, input: false },
      disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
    },
  },
  session: {
    modelName: 'authSession',
    expiresIn: 7 * 86400,
    freshAge: 600,
    cookieCache: { enabled: false },
    additionalFields: {
      method: { type: 'string', required: false, input: false, defaultValue: 'unknown' },
    },
  },
  account: { modelName: 'authAccount', encryptOAuthTokens: true },
  verification: { modelName: 'authVerification' },
  emailAndPassword: {
    enabled: false,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'authRateLimit',
    window: 60,
    max: demo ? 300 : 60,
    customRules: {
      '/sign-in/opaque/*': { window: 60, max: demo ? 100 : 10 },
      '/opaque/*/*': { window: 60, max: demo ? 100 : 10 },
      ...(demo
        ? {
            '/two-factor/*': { window: 10, max: 30 },
            '/sign-in/*': { window: 60, max: 100 },
            '/passkey/*': { window: 60, max: 100 },
          }
        : {}),
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const referral = ctx?.headers?.get('x-getgpt-referral')?.slice(0, 40)
          const adapter = await hookAdapter(ctx?.context)
          const inviter = referral
            ? await adapter.findOne<{ id: string }>({
                model: 'user',
                where: [
                  { field: 'referralCode', value: referral },
                  { field: 'email', operator: 'ne', value: user.email },
                  { field: 'disabled', value: false },
                ],
              })
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
          const adapter = await hookAdapter(ctx?.context)
          if (
            !(await adapter.findOne({
              model: 'user',
              where: [
                { field: 'id', value: session.userId },
                { field: 'disabled', value: false },
              ],
            }))
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
                  : path === '/sign-in/opaque/complete'
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
    await opaqueAuth(),
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
      rpName: 'GetCodex Plus',
      origin: appUrl,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      schema: { passkey: { modelName: 'authPasskey' } },
    }),
    mfa,
    policy,
  ],
})
