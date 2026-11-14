import { z } from 'zod'
import { db, transaction, type DbClient } from '../db'
import { stringRecord, jsonInput } from '../data'
import { advisoryLock, lockIntegration, lockSettings } from '../database-sql'
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
export async function integration(
  provider: IntegrationKind,
  revision?: string,
  client: DbClient = db,
) {
  const result = await client.integration.findFirst({
    where: { provider, ...(revision ? { id: revision } : { active: true }) },
  })
  if (!result || (!revision && !result.enabled))
    throw new ApiError(503, '该服务尚未启用，请联系管理员')
  return {
    id: result.id,
    ...stringRecord(result.public),
    ...JSON.parse(decrypt(result.secret, `integration:${provider}`)),
  } as Record<string, string>
}
export async function integrationViews(): Promise<IntegrationView[]> {
  return (
    await db.integration.findMany({ where: { active: true }, orderBy: { provider: 'asc' } })
  ).map((record) => ({
    id: record.id,
    provider: z.enum(providers).parse(record.provider),
    public: stringRecord(record.public),
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    secrets: Object.keys(JSON.parse(decrypt(record.secret, `integration:${record.provider}`))),
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
    await advisoryLock(client, `integration:${isEpay ? 'epay' : input.provider}`)
    await lockIntegration(client, input.provider)
    const previous = await client.integration.findFirst({
      where: { provider: input.provider, active: true },
    })
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
      const protocols = ['http:', 'https:']
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
            : '支付网关地址需为 HTTP 或 HTTPS，不含登录信息、查询参数或片段',
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
    await client.integration.updateMany({
      where: { provider: input.provider, active: true },
      data: { active: false },
    })
    const revision = id('cfg_')
    await client.integration.create({
      data: {
        id: revision,
        provider: input.provider,
        public: fields,
        secret: encrypt(JSON.stringify(secrets), `integration:${input.provider}`),
        enabled: input.enabled,
      },
    })
    if (isEpay) {
      await lockSettings(client)
      const current = await client.setting.findUnique({ where: { id: 1 } })
      if (current) {
        const body = z.record(z.string(), z.unknown()).parse(current.body)
        await client.setting.update({
          where: { id: 1 },
          data: {
            body: jsonInput({
              ...body,
              epayVersion: input.provider,
              ...(['epay_v1', 'epay_v2'].includes(String(body.fiatProvider))
                ? { fiatProvider: input.provider }
                : {}),
            }),
          },
        })
      }
    }
    await client.audit.create({
      data: {
        id: id('a_'),
        actor,
        action: '更新服务配置',
        target: `${input.provider}:${revision}`,
      },
    })
    return { saved: true }
  })
}
