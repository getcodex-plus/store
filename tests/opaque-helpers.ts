import type { APIRequestContext } from '@playwright/test'
import { client, ready } from '@serenity-kit/opaque'

export async function opaqueLogin(
  request: APIRequestContext,
  email: string,
  password: string,
  headers: Record<string, string>,
) {
  await ready
  const { clientLoginState, startLoginRequest } = client.startLogin({ password })
  const response = await request.post('/api/auth/sign-in/opaque/challenge', {
    headers,
    data: { email, loginRequest: startLoginRequest },
  })
  if (!response.ok()) throw new Error(`OPAQUE challenge failed: ${response.status()}`)
  const { challenge, state } = await response.json()
  const result = client.finishLogin({ password, clientLoginState, loginResponse: challenge })
  if (!result) throw new Error('OPAQUE password verification failed')
  return request.post('/api/auth/sign-in/opaque/complete', {
    headers,
    data: { email, loginResult: result.finishLoginRequest, encryptedServerState: state },
  })
}
