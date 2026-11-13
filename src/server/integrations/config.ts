import { z } from 'zod'
import { rows, transaction } from '../db'
import { ApiError } from '../config'
import { decrypt, encrypt, id } from '../crypto'

export const providers = [
  'xorpay',
  'gmpay',
  'epay_v1',
  'epay_v2',
  'aicdk',
  'smtp',
  'resend',
  'turnstile',
] as const
export type IntegrationKind = (typeof providers)[number]
export interface IntegrationView {
  id: string
  provider: IntegrationKind
  public: Record<string, string>
  enabled: boolean
  secrets: string[]
  createdAt: string
}
interface IntegrationRecord extends Omit<IntegrationView, 'secrets'> {
  secret: string
}
const publicKeys: Record<IntegrationKind, string[]> = {
  xorpay: ['appId'],
  gmpay: ['url', 'pid'],
  epay_v1: ['url', 'pid'],
  epay_v2: ['url', 'pid'],
  aicdk: ['url'],
  smtp: ['host', 'port', 'user', 'from'],
  resend: ['from'],
  turnstile: ['siteKey', 'login', 'purchase'],
}
const secretKeys: Record<IntegrationKind, string[]> = {
  xorpay: ['secret'],
  gmpay: ['secret'],
  epay_v1: ['key'],
  epay_v2: ['privateKey', 'publicKey'],
  aicdk: ['apiKey'],
  smtp: ['password'],
  resend: ['apiKey'],
  turnstile: ['secret'],
}
export async function integration(provider: IntegrationKind, revision?: string) {
  const result = await rows<IntegrationRecord>(
    `SELECT * FROM integrations WHERE provider=$1 AND ${revision ? 'id=$2' : 'active=true'}`,
    revision ? [provider, revision] : [provider],
  )
  if (!result[0] || (!revision && !result[0].enabled))
    throw new ApiError(503, '该服务尚未启用，请联系管理员')
  return {
    id: result[0].id,
    ...result[0].public,
    ...JSON.parse(decrypt(result[0].secret, `integration:${provider}`)),
  } as Record<string, string>
}
export async function integrationViews(): Promise<IntegrationView[]> {
  return (
    await rows<IntegrationRecord>('SELECT * FROM integrations WHERE active=true ORDER BY provider')
  ).map(({ secret, ...rest }) => ({
    ...rest,
    secrets: Object.keys(JSON.parse(decrypt(secret, `integration:${rest.provider}`))),
  }))
}
export const integrationSchema = z.object({
  provider: z.enum(providers),
  enabled: z.boolean(),
  public: z.record(z.string(), z.string().max(2048)),
  secrets: z.record(z.string(), z.string().max(16000)),
})
export async function saveIntegration(input: z.infer<typeof integrationSchema>, actor: string) {
  return transaction(async (client) => {
    const isEpay = input.provider === 'epay_v1' || input.provider === 'epay_v2'
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `integration:${isEpay ? 'epay' : input.provider}`,
    ])
    const previous = (
      await rows<IntegrationRecord>(
        'SELECT * FROM integrations WHERE provider=$1 AND active=true FOR UPDATE',
        [input.provider],
        client,
      )
    )[0]
    const fields = Object.fromEntries(
      publicKeys[input.provider].map((key) => [key, (input.public[key] ?? '').trim()]),
    )
    const secrets: Record<string, string> = previous
      ? JSON.parse(decrypt(previous.secret, `integration:${input.provider}`))
      : {}
    for (const key of secretKeys[input.provider])
      if (input.secrets[key]?.trim()) secrets[key] = input.secrets[key].trim().replace(/\\n/g, '\n')
    if (
      input.provider === 'turnstile' &&
      input.enabled &&
      (!['true', 'false'].includes(fields.login) || !['true', 'false'].includes(fields.purchase))
    )
      throw new ApiError(400, '请选择需要开启安全验证的场景')
    if (fields.url) {
      let url: URL
      try {
        url = new URL(fields.url)
      } catch {
        throw new ApiError(400, '服务地址格式不正确')
      }
      const protocols = input.provider === 'aicdk' ? ['http:', 'https:'] : ['https:']
      if (
        !protocols.includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new ApiError(
          400,
          input.provider === 'aicdk'
            ? 'AICDK 地址需为 HTTP 或 HTTPS，不含登录信息、查询参数或片段'
            : '支付网关地址需为 HTTPS，不含登录信息、查询参数或片段',
        )
      }
    }
    if (
      input.enabled &&
      [
        ...publicKeys[input.provider].map((key) => fields[key]),
        ...secretKeys[input.provider].map((key) => secrets[key]),
      ].some((value) => !value)
    )
      throw new ApiError(400, '请先填写完整配置再启用')
    await client.query('UPDATE integrations SET active=false WHERE provider=$1 AND active=true', [
      input.provider,
    ])
    const revision = id('cfg_')
    await client.query(
      'INSERT INTO integrations(id,provider,public,secret,enabled) VALUES($1,$2,$3,$4,$5)',
      [
        revision,
        input.provider,
        JSON.stringify(fields),
        encrypt(JSON.stringify(secrets), `integration:${input.provider}`),
        input.enabled,
      ],
    )
    if (isEpay) {
      // Keep historical provider/configuration IDs for existing orders and callbacks.
      // Selecting a protocol changes new EPay orders only, in the same transaction.
      await client.query(
        `UPDATE settings SET body=body || jsonb_build_object('epayVersion',$1::text) ||
          CASE WHEN body->>'fiatProvider' IN ('epay_v1','epay_v2')
          THEN jsonb_build_object('fiatProvider',$1::text) ELSE '{}'::jsonb END WHERE id=1`,
        [input.provider],
      )
    }
    await client.query('INSERT INTO audit(id,actor,action,target) VALUES($1,$2,$3,$4)', [
      id('a_'),
      actor,
      '更新服务配置',
      `${input.provider}:${revision}`,
    ])
    return { saved: true }
  })
}
