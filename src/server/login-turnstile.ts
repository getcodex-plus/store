import type { GenericEndpointContext } from '@better-auth/core'
import { expireCookie } from 'better-auth/cookies'
import { hash, id } from './crypto'
import { turnstilePublic } from './turnstile'
import { checkRiskChallenge } from './risk'

const cookieName = 'login_verification'
const maxAge = 300
const identifier = (token: string) => `turnstile-login:${hash(token)}`
type ReceiptContext = GenericEndpointContext['context'] & { loginTurnstileReceipt?: string }

// A login-only, revocable receipt lets email and password share one
// Siteverify result. It never grants a session or bypasses credential checks.
export async function requireLoginTurnstile(ctx: GenericEndpointContext) {
  if (!(await turnstilePublic()).login) return
  const cookie = ctx.context.createAuthCookie(cookieName, { maxAge })
  const token = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
  const challenge = ctx.headers?.get('x-turnstile-token')
  if (token && !challenge) {
    const receipt = await ctx.context.internalAdapter.findVerificationValue(identifier(token))
    if (receipt?.value === 'login' && receipt.expiresAt.getTime() > Date.now()) return
  }
  await checkRiskChallenge('login', challenge)
  if (token) await ctx.context.internalAdapter.consumeVerificationValue(identifier(token))
  const nextToken = id()
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: identifier(nextToken),
    value: 'login',
    expiresAt: new Date(Date.now() + maxAge * 1000),
  })
  ;(ctx.context as ReceiptContext).loginTurnstileReceipt = nextToken
  await ctx.setSignedCookie(cookie.name, nextToken, ctx.context.secret, cookie.attributes)
}

export async function clearLoginTurnstile(ctx: GenericEndpointContext) {
  const cookie = ctx.context.createAuthCookie(cookieName, { maxAge })
  const token =
    (ctx.context as ReceiptContext).loginTurnstileReceipt ||
    (await ctx.getSignedCookie(cookie.name, ctx.context.secret))
  if (token) await ctx.context.internalAdapter.consumeVerificationValue(identifier(token))
  expireCookie(ctx, cookie)
}
