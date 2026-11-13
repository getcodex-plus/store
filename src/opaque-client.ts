'use client'
import { authClient, authResult } from './auth-client'

type Challenge = { challenge: string; state: string }
type LoginResult = { success?: boolean; twoFactorRedirect?: boolean; twoFactorMethods?: string[] }

async function post<T>(path: string, body: object, headers?: HeadersInit): Promise<T> {
  return authResult(await authClient.$fetch<T>(path, { method: 'POST', body, headers }))
}

async function cryptography() {
  const opaque = await import('@serenity-kit/opaque')
  await opaque.ready
  return opaque.client
}

function checkPassword(value: string) {
  if (value.length < 12 || value.length > 128) throw new Error('密码长度为 12–128 个字符')
}

// Passwords and client protocol states stay in memory on the client.
export async function signInOpaque(email: string, password: string, headers?: HeadersInit) {
  if (!password || password.length > 128) throw new Error('请检查密码')
  const client = await cryptography()
  const { clientLoginState, startLoginRequest } = client.startLogin({ password })
  const challenge = await post<Challenge>(
    '/sign-in/opaque/challenge',
    {
      email: email.trim().toLowerCase(),
      loginRequest: startLoginRequest,
    },
    headers,
  )
  const result = client.finishLogin({
    password,
    clientLoginState,
    loginResponse: challenge.challenge,
  })
  if (!result) throw new Error('邮箱或密码不正确')
  return post<LoginResult>('/sign-in/opaque/complete', {
    email: email.trim().toLowerCase(),
    loginResult: result.finishLoginRequest,
    encryptedServerState: challenge.state,
  })
}

export async function enrollOpaque(password: string) {
  checkPassword(password)
  const client = await cryptography()
  const { clientRegistrationState, registrationRequest } = client.startRegistration({ password })
  const { challenge, state } = await post<Challenge>('/opaque/enroll/challenge', {
    registrationRequest,
  })
  const { registrationRecord } = client.finishRegistration({
    password,
    clientRegistrationState,
    registrationResponse: challenge,
  })
  return post('/opaque/enroll/complete', { registrationRecord, state })
}

export async function changeOpaquePassword(currentPassword: string, newPassword: string) {
  checkPassword(newPassword)
  const client = await cryptography()
  const { clientLoginState, startLoginRequest } = client.startLogin({ password: currentPassword })
  const { clientRegistrationState, registrationRequest } = client.startRegistration({
    password: newPassword,
  })
  const challenge = await post<{
    loginChallenge: string
    registrationChallenge: string
    state: string
  }>('/opaque/changePassword/challenge', { loginRequest: startLoginRequest, registrationRequest })
  const result = client.finishLogin({
    password: currentPassword,
    clientLoginState,
    loginResponse: challenge.loginChallenge,
  })
  if (!result) throw new Error('当前密码不正确')
  const { registrationRecord } = client.finishRegistration({
    password: newPassword,
    clientRegistrationState,
    registrationResponse: challenge.registrationChallenge,
  })
  return post('/opaque/changePassword/complete', {
    loginResult: result.finishLoginRequest,
    registrationRecord,
    encryptedServerState: challenge.state,
  })
}
