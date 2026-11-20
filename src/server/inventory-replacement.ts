import { ApiError } from './config'
import { id } from './crypto'
import { jsonInput } from './data'
import { transaction, upstreamTransaction, type DbClient } from './db'
import { lockRow } from './database-sql'
import { inventoryFingerprint, openCredential, sealCredential } from './credential-storage'
import { integration } from './integrations/config'
import {
  previewReplacement,
  replaceCode,
  replacementPreviewSchema,
  UpstreamError,
} from './integrations/aicdk'

const needsReview = '上游已换码，但新码未能安全保存；旧码已锁定，请到 AICDK 核对处理'

export async function replaceInventory(inventoryId: string, actor: string) {
  // Commit the identity and quarantine BEFORE making the irreversible request.
  // A crash, timeout or failed final commit must never put the old code on sale.
  await transaction(async (client) => {
    await lockRow(client, 'inventory', inventoryId)
    const source = await client.inventory.findUnique({
      where: { id: inventoryId },
      include: {
        replacement: true,
        quotes: { where: { order: { is: { status: { not: 'cancelled' } } } }, take: 1 },
      },
    })
    if (!source) throw new ApiError(404, '兑换码记录不存在，请刷新后重试')
    if (source.replacement?.orderId) throw new ApiError(409, '请在原订单核对这次卡密释放')
    if (source.replacement) return
    if (source.status !== 'available' || source.quotes.length)
      throw new ApiError(409, '已占用或已使用的兑换码不能更换')
    const config = await integration('aicdk', undefined, client)
    await prepareReplacement(client, source, config, actor)
  }, upstreamTransaction)
  return finishReplacement(inventoryId, actor)
}

export async function prepareReplacement(
  client: DbClient,
  source: { id: string; code: string; enabled: boolean },
  config: Record<string, string>,
  actor: string,
  release?: { orderId: string; round: number; plan: string },
) {
  let preview
  try {
    preview = await previewReplacement(openCredential(source.code, 'inventory', source.id), config)
  } catch (error) {
    if (error instanceof UpstreamError)
      throw new ApiError(409, '上游暂不允许更换此码，请检查兑换码状态和应用密钥的兑换权限')
    throw error
  }
  if (
    release &&
    (preview.plan !== release.plan ||
      (preview.expires_at && Date.parse(preview.expires_at) <= Date.now()))
  )
    throw new ApiError(409, '旧卡套餐不符或已过期，未释放库存')
  await client.inventoryReplacement.create({
    data: {
      id: id('replace_'),
      inventoryId: source.id,
      orderId: release?.orderId,
      orderRound: release?.round,
      integrationId: config.id,
      preview: jsonInput(preview),
      restoreEnabled: source.enabled,
    },
  })
  await client.inventory.update({ where: { id: source.id }, data: { enabled: false } })
  await client.audit.create({
    data: {
      id: id('a_'),
      actor,
      action: release ? '手动释放订单卡密：发起置换' : '发起上游换码',
      target: release ? `${release.orderId}:${release.round}:${source.id}` : source.id,
    },
  })
}

export async function finishReplacement(
  inventoryId: string,
  actor: string,
  retryLabel: '核对换码' | '核对释放结果' = '核对换码',
) {
  const outcome = await transaction(async (client) => {
    // Duplicate requests serialize here and return the already saved result.
    await lockRow(client, 'inventory', inventoryId)
    const source = await client.inventory.findUniqueOrThrow({
      where: { id: inventoryId },
      include: { replacement: true },
    })
    const request = source.replacement!
    if (request.state === 'completed')
      return { saved: true as const, replacementId: request.replacementInventoryId! }
    if (request.state === 'review') return { review: true as const }
    if (request.orderId && source.status !== 'reserved')
      throw new ApiError(409, '原卡已不再由失败订单占用')
    const config = await integration('aicdk', request.integrationId, client)
    // Never preview a retry: after a successful request the original is disabled
    // upstream. The saved key and pinned integration recover that same request.
    const result = await replaceCode(
      openCredential(source.code, 'inventory', inventoryId),
      request.id,
      config,
    )
    const preview = replacementPreviewSchema.parse(request.preview)
    const valid =
      result.product_id === preview.product_id &&
      result.plan === preview.plan &&
      result.expires_at === preview.expires_at &&
      (!request.orderId || !result.expires_at || Date.parse(result.expires_at) > Date.now()) &&
      !!result.new_code
    const fingerprint = result.new_code ? inventoryFingerprint(result.new_code) : null
    const duplicate = fingerprint
      ? await client.inventory.findUnique({ where: { fingerprint }, select: { id: true } })
      : null
    if (!valid || duplicate) {
      await client.inventoryReplacement.update({
        where: { id: request.id },
        data: {
          state: 'review',
          upstreamReplacementId: result.id,
          upstreamCodeId: result.new_code_id,
        },
      })
      await client.audit.create({
        data: {
          id: id('a_'),
          actor,
          action: '上游换码需核对',
          target: `${inventoryId}:${result.new_code_id}`,
        },
      })
      return { review: true as const }
    }
    const replacementId = id('i_')
    await client.inventory.create({
      data: {
        id: replacementId,
        productId: source.productId,
        batchId: source.batchId,
        discountCountry: source.discountCountry,
        enabled: request.restoreEnabled,
        code: sealCredential(result.new_code!, 'inventory', replacementId),
        fingerprint: fingerprint!,
      },
    })
    await client.inventoryReplacement.update({
      where: { id: request.id },
      data: {
        state: 'completed',
        replacementInventoryId: replacementId,
        upstreamReplacementId: result.id,
        upstreamCodeId: result.new_code_id,
      },
    })
    if (request.orderId)
      await client.inventory.update({
        where: { id: inventoryId },
        data: { status: 'available', enabled: false, reservedUntil: null },
      })
    await client.audit.create({
      data: {
        id: id('a_'),
        actor,
        action: request.orderId ? '手动释放订单卡密：新码已入库' : '上游更换兑换码',
        target: [request.orderId, inventoryId, replacementId].filter(Boolean).join(':'),
      },
    })
    return { saved: true as const, replacementId }
  }, upstreamTransaction).catch(() => {
    // No upstream body or secret may escape into admin responses or logs.
    throw new ApiError(409, `换码结果待核对，旧码已锁定；请使用「${retryLabel}」继续原请求`)
  })
  if ('review' in outcome) throw new ApiError(409, needsReview)
  return outcome
}
