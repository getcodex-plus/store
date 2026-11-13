import type { GenericEndpointContext } from '@better-auth/core'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { server } from '@serenity-kit/opaque'
import { opaque } from 'better-auth-opaque'
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies'
import { symmetricDecrypt } from 'better-auth/crypto'
import { z } from 'zod'
import { hash, id } from './crypto'
import { opaqueSetup } from './opaque-setup'

type Context = GenericEndpointContext
type Purpose = 'login' | 'enroll' | 'change' | 'reset'
type OpaqueAccount = { id: string; registrationRecord?: string | null }
type Ticket = {
  purpose: Purpose
  userId: string | null
  email: string
  credential: string | null
  session: string | null
}
const invalid = () => new APIError('UNAUTHORIZED', { message: '验证已失效，请重新开始' })
const encoded = (bytes: number) =>
  z
    .string()
    .max(Math.ceil((bytes * 4) / 3))
    .base64url()
    .refine((v) => Buffer.from(v, 'base64url').length === bytes)
const recordSchema = encoded(192)
const stateSchema = z.string().min(1).max(4096)

async function account(ctx: Context, userId: string): Promise<OpaqueAccount | undefined> {
  const accounts = await ctx.context.internalAdapter.findAccounts(userId)
  return accounts.find((item) => item.providerId === 'opaque') as OpaqueAccount | undefined
}

async function requireRecoverySession(
  ctx: Context,
  session: NonNullable<Context['context']['session']>,
) {
  const method = (session.session as typeof session.session & { method?: string }).method
  if (
    !session.user.emailVerified ||
    session.session.expiresAt <= new Date() ||
    Date.now() - new Date(session.session.createdAt).getTime() > 600_000 ||
    !['email', 'passkey', 'mfa'].includes(method || '')
  )
    throw new APIError('FORBIDDEN', {
      message: '请重新通过邮箱验证码或 Passkey 验证身份后重置密码',
    })
  const adapter = await getCurrentAdapter(ctx.context.adapter)
  if (
    method === 'email' &&
    (await adapter.findOne({
      model: 'twoFactor',
      where: [
        { field: 'userId', value: session.user.id },
        { field: 'verified', value: true },
      ],
    }))
  )
    throw new APIError('FORBIDDEN', { message: '请完成账号所需的二步验证后重置密码' })
}

// Persist only a digest of the opaque state. A ticket is scoped to its endpoint,
// credential version and (for changes) the exact authenticated session.
async function snapshot(ctx: Context, purpose: Purpose, email: string): Promise<Ticket> {
  const user = await ctx.context.internalAdapter.findUserByEmail(email)
  const credential = user ? (await account(ctx, user.user.id))?.registrationRecord : null
  return {
    purpose,
    userId: user?.user.id ?? null,
    email,
    credential: credential ? hash(credential) : null,
    session: purpose === 'login' ? null : hash(ctx.context.session!.session.token),
  }
}

async function remember(ctx: Context, state: string, ticket: Ticket) {
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: `opaque:${hash(state)}`,
    value: JSON.stringify(ticket),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  })
}

async function consume(ctx: Context, state: string, purpose: Purpose) {
  const entry = await ctx.context.internalAdapter.consumeVerificationValue(`opaque:${hash(state)}`)
  if (!entry) throw invalid()
  const ticket = JSON.parse(entry.value) as Ticket
  if (
    ticket.purpose !== purpose ||
    !ticket.userId ||
    (purpose !== 'login' &&
      (ticket.userId !== ctx.context.session?.user.id ||
        ticket.session !== hash(ctx.context.session.session.token)))
  )
    throw invalid()
  return ticket
}

// All successful completions lock the same user row in a Better Auth transaction.
// This serializes password replacement with session creation and factor changes.
async function lockUser(ctx: Context, ticket: Ticket) {
  const adapter = await getCurrentAdapter(ctx.context.adapter)
  const locked = await adapter.update({
    model: 'user',
    where: [{ field: 'id', value: ticket.userId! }],
    update: { updatedAt: new Date() },
  })
  if (!locked) throw invalid()
  const user = await ctx.context.internalAdapter.findUserById(ticket.userId!)
  if (
    !user ||
    user.email !== ticket.email ||
    !user.emailVerified ||
    (user as typeof user & { disabled: boolean }).disabled
  )
    throw invalid()
  const current = await account(ctx, user.id)
  if ((current?.registrationRecord ? hash(current.registrationRecord) : null) !== ticket.credential)
    throw invalid()
  if (ticket.purpose !== 'login') {
    const session = await ctx.context.internalAdapter.findSession(
      ctx.context.session!.session.token,
    )
    if (!session || session.session.expiresAt <= new Date()) throw invalid()
    if (ticket.purpose === 'reset') await requireRecoverySession(ctx, session)
  }
  return { user, current, adapter }
}

async function verifyProof(ctx: Context, state: string, proof: string, ticket: Ticket) {
  try {
    const payload = JSON.parse(await symmetricDecrypt({ key: ctx.context.secret, data: state }))
    if (payload.user?.id !== ticket.userId || payload.user?.email !== ticket.email) throw invalid()
    if (
      !server.finishLogin({ serverLoginState: payload.serverLoginState, finishLoginRequest: proof })
        .sessionKey
    )
      throw invalid()
  } catch {
    throw invalid()
  }
}

export async function opaqueAuth() {
  const setup = await opaqueSetup()
  const upstream = opaque({ OPAQUE_SERVER_KEY: setup })
  return {
    ...upstream,
    schema: {
      account: {
        fields: {
          registrationRecord: {
            ...upstream.schema.account.fields.registrationRecord,
            input: false,
            returned: false,
          },
        },
      },
    },
    endpoints: {
      // Registration starts from an already verified email/Passkey session.
      // Do not expose the upstream public sign-up endpoints.
      getLoginChallenge: createAuthEndpoint(
        '/sign-in/opaque/challenge',
        {
          method: 'POST',
          body: z.object({
            email: z.email().transform((v) => v.trim().toLowerCase()),
            loginRequest: encoded(96),
          }),
        },
        async (ctx) => {
          const ticket = await snapshot(ctx, 'login', ctx.body.email)
          const result = await upstream.endpoints.getLoginChallenge({
            ...ctx,
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          })
          await remember(ctx, result.state, ticket)
          return result
        },
      ),
      completeLogin: createAuthEndpoint(
        '/sign-in/opaque/complete',
        {
          method: 'POST',
          body: z.object({
            email: z.email().transform((v) => v.trim().toLowerCase()),
            loginResult: encoded(64),
            encryptedServerState: stateSchema,
          }),
        },
        async (ctx) => {
          const ticket = await consume(ctx, ctx.body.encryptedServerState, 'login')
          if (ticket.email !== ctx.body.email || !ticket.credential) throw invalid()
          await verifyProof(ctx, ctx.body.encryptedServerState, ctx.body.loginResult, ticket)
          const result = await runWithTransaction(ctx.context.adapter, async () => {
            const { user } = await lockUser(ctx, ticket)
            const session = await ctx.context.internalAdapter.createSession(user.id, false)
            if (!session) throw invalid()
            return { session, user }
          })
          await setSessionCookie(ctx, result)
          return ctx.json({ success: true })
        },
      ),
      getEnrollChallenge: createAuthEndpoint(
        '/opaque/enroll/challenge',
        {
          method: 'POST',
          body: z.object({ registrationRequest: encoded(32) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          if (await account(ctx, ctx.context.session.user.id))
            throw new APIError('BAD_REQUEST', { message: '已设置密码，请使用修改密码' })
          const { registrationResponse } = server.createRegistrationResponse({
            serverSetup: setup,
            userIdentifier: ctx.context.session.user.email,
            registrationRequest: ctx.body.registrationRequest,
          })
          const state = id()
          await remember(ctx, state, await snapshot(ctx, 'enroll', ctx.context.session.user.email))
          return { challenge: registrationResponse, state }
        },
      ),
      completeEnrollment: createAuthEndpoint(
        '/opaque/enroll/complete',
        {
          method: 'POST',
          body: z.object({ registrationRecord: recordSchema, state: stateSchema }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const ticket = await consume(ctx, ctx.body.state, 'enroll')
          await runWithTransaction(ctx.context.adapter, async () => {
            const { user, current, adapter } = await lockUser(ctx, ticket)
            if (current) throw invalid()
            await ctx.context.internalAdapter.createAccount({
              userId: user.id,
              accountId: user.id,
              providerId: 'opaque',
              registrationRecord: ctx.body.registrationRecord,
            })
            await adapter.deleteMany({
              model: 'session',
              where: [
                { field: 'userId', value: user.id },
                { field: 'token', operator: 'ne', value: ctx.context.session.session.token },
              ],
            })
          })
          return { success: true }
        },
      ),
      getResetPasswordChallenge: createAuthEndpoint(
        '/opaque/resetPassword/challenge',
        {
          method: 'POST',
          body: z.object({ registrationRequest: encoded(32) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          await requireRecoverySession(ctx, ctx.context.session)
          if (!(await account(ctx, ctx.context.session.user.id)))
            throw new APIError('BAD_REQUEST', {
              message: '此账号尚未设置密码，请在账号安全页面设置登录密码',
            })
          const { registrationResponse } = server.createRegistrationResponse({
            serverSetup: setup,
            userIdentifier: ctx.context.session.user.email,
            registrationRequest: ctx.body.registrationRequest,
          })
          const state = id()
          await remember(ctx, state, await snapshot(ctx, 'reset', ctx.context.session.user.email))
          return { challenge: registrationResponse, state }
        },
      ),
      completeResetPassword: createAuthEndpoint(
        '/opaque/resetPassword/complete',
        {
          method: 'POST',
          body: z.object({ registrationRecord: recordSchema, state: stateSchema }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const ticket = await consume(ctx, ctx.body.state, 'reset')
          await runWithTransaction(ctx.context.adapter, async () => {
            const { current, user, adapter } = await lockUser(ctx, ticket)
            if (!current) throw invalid()
            await adapter.update({
              model: 'account',
              where: [{ field: 'id', value: current.id }],
              update: { registrationRecord: ctx.body.registrationRecord, updatedAt: new Date() },
            })
            await adapter.deleteMany({
              model: 'session',
              where: [{ field: 'userId', value: user.id }],
            })
          })
          deleteSessionCookie(ctx)
          return { success: true }
        },
      ),
      getChangePasswordChallenge: createAuthEndpoint(
        '/opaque/changePassword/challenge',
        {
          method: 'POST',
          requireHeaders: true,
          body: z.object({ loginRequest: encoded(96), registrationRequest: encoded(32) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const ticket = await snapshot(ctx, 'change', ctx.context.session.user.email)
          const result = await upstream.endpoints.getChangePasswordChallenge({
            ...ctx,
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          })
          await remember(ctx, result.state, ticket)
          return result
        },
      ),
      completeChangePassword: createAuthEndpoint(
        '/opaque/changePassword/complete',
        {
          method: 'POST',
          body: z.object({
            loginResult: encoded(64),
            registrationRecord: recordSchema,
            encryptedServerState: stateSchema,
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const ticket = await consume(ctx, ctx.body.encryptedServerState, 'change')
          await verifyProof(ctx, ctx.body.encryptedServerState, ctx.body.loginResult, ticket)
          await runWithTransaction(ctx.context.adapter, async () => {
            const { user, current, adapter } = await lockUser(ctx, ticket)
            if (!current) throw invalid()
            await adapter.update({
              model: 'account',
              where: [{ field: 'id', value: current.id }],
              update: { registrationRecord: ctx.body.registrationRecord, updatedAt: new Date() },
            })
            await adapter.deleteMany({
              model: 'session',
              where: [
                { field: 'userId', value: user.id },
                { field: 'token', operator: 'ne', value: ctx.context.session.session.token },
              ],
            })
          })
          return { success: true }
        },
      ),
    },
  }
}
