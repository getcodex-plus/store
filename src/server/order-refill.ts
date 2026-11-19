import { parseSession } from '../lib'
import {
  redemptionRequestId,
  refillHistorySchema,
  refillInput,
  type RefillHistory,
} from '../order-refill'
import { orderResolutionSchema } from '../order-resolution'
import type { User } from '../types'
import type { Order as OrderRecord } from '../generated/prisma/client'
import { ApiError, demo } from './config'
import { openCredential, sealCredential } from './credential-storage'
import { id } from './crypto'
import { canOfferRefill, quoteView } from './data'
import { databaseNow, lockRow, reserveInventory } from './database-sql'
import { checkoutTransaction, Prisma, transaction, type DbClient } from './db'
import { fulfillmentBusiness, validateFulfillment } from './fulfillment-policy'
import {
  aicdkPlan,
  findRedemption,
  getRedemption,
  preflight,
  previewReplacement,
  UpstreamError,
} from './integrations/aicdk'
import { integration } from './integrations/config'
import { recordResolutionConflict } from './order-resolution'

async function restartPolling(client: DbClient, orderId: string, now: Date) {
  await client.job.upsert({
    where: { orderId },
    create: { id: id('job_'), orderId },
    update: {
      done: false,
      attempts: 0,
      runAt: now,
      lockedUntil: null,
      lease: null,
      lastError: null,
    },
  })
}

async function verifyPayment(client: DbClient, order: OrderRecord) {
  if (
    order.externalAmount > 0 &&
    (!order.paymentId ||
      !(await client.paymentEvent.count({
        where: { provider: order.provider, transactionId: order.paymentId, orderId: order.id },
      })))
  )
    throw new ApiError(409, '原订单收款记录待核对，请联系支持')
  if (
    order.balanceAmount > 0 &&
    !(await client.walletEntry.count({
      where: {
        orderId: order.id,
        userId: order.userId!,
        kind: 'purchase',
        amount: -order.balanceAmount,
      },
    }))
  )
    throw new ApiError(409, '原订单余额扣款记录待核对，请联系支持')
}

export async function refillOrder(
  user: User | null,
  browser: string,
  orderId: string,
  data: unknown,
) {
  const input = refillInput.parse(data)
  if (demo) throw new ApiError(409, '演示订单不能发起上游补充')
  const accepted = await transaction(async (client) => {
    await lockRow(client, 'orders', orderId)
    const record = await client.order.findFirst({
      where: {
        id: orderId,
        OR: [
          ...(user ? [{ userId: user.id }] : []),
          ...(browser ? [{ userId: null, guestBrowserDigest: browser }] : []),
        ],
      },
    })
    if (!record) throw new ApiError(404, '未找到订单')
    const history = refillHistorySchema.parse(record.refillHistory)
    if (input.round < history.length) return true
    if (input.round !== history.length || !canOfferRefill(record))
      throw new ApiError(409, '当前订单不能补充，请刷新订单核对状态')
    let session: ReturnType<typeof parseSession>
    try {
      session = parseSession(input.session)
    } catch {
      throw new ApiError(400, '请重新复制原充值账号的完整会话信息')
    }
    if (session.user.email.toLowerCase() !== record.email)
      throw new ApiError(400, '请使用原充值账号的信息')
    await verifyPayment(client, record)
    await lockRow(client, 'quotes', record.quoteId)
    const stored = await client.quote.findUniqueOrThrow({ where: { id: record.quoteId! } })
    const quote = quoteView(stored)
    if (
      !quote.inventoryId ||
      !quote.targetPlan ||
      quote.productId !== record.productId ||
      quote.email !== record.email ||
      quote.aicdkIntegrationId !== record.aicdkIntegrationId
    )
      throw new ApiError(409, '原订单库存或报价需由管理员核对')

    const config = await integration('aicdk', record.aicdkIntegrationId!, client)
    const requestId = redemptionRequestId(orderId, input.round)
    const previous = record.redemptionId
      ? await getRedemption(record.redemptionId, config)
      : await findRedemption(requestId, config)
    const resolution = record.fulfillmentResolution
      ? orderResolutionSchema.parse(record.fulfillmentResolution)
      : null
    let outcome: RefillHistory[number]['outcome'] = 'not_submitted'
    if (previous) {
      validateFulfillment(previous, quote, requestId)
      if (previous.version < record.redemptionVersion)
        throw new ApiError(409, '上游记录尚未同步，请稍后核对原订单')
      if (previous.status !== 'failed' && previous.status !== 'cancelled') {
        if (resolution) await recordResolutionConflict(client, record, previous)
        else {
          await client.order.update({
            where: { id: orderId },
            data: {
              status: 'processing',
              redemptionId: previous.id,
              redemptionVersion: previous.version,
              fulfillmentStatus: previous.status,
              submissionAttempted: true,
            },
          })
          await client.quote.update({ where: { id: quote.id }, data: { preflightToken: null } })
          await restartPolling(client, orderId, await databaseNow(client))
        }
        return false
      }
      outcome = previous.status
    } else if (
      record.submissionAttempted ||
      record.redemptionId ||
      record.redemptionVersion !== 0 ||
      record.fulfillmentStatus ||
      resolution?.outcome !== 'failed'
    ) {
      throw new ApiError(409, '尚不能确认原兑换已终止，请联系支持，不要重复充值')
    }

    const country = quote.pricingSnapshot?.fulfillment?.country ?? null
    const spare = await reserveInventory(client, quote.productId, country)
    await lockRow(client, 'inventory', quote.inventoryId)
    const original = await client.inventory.findUniqueOrThrow({
      where: { id: quote.inventoryId },
      include: {
        batch: { select: { enabled: true } },
        replacement: { select: { id: true } },
        quotes: {
          where: { id: { not: quote.id }, order: { is: { status: { not: 'cancelled' } } } },
          take: 1,
          select: { id: true },
        },
      },
    })
    if (
      original.status !== 'reserved' ||
      original.productId !== quote.productId ||
      original.discountCountry !== country ||
      original.replacement ||
      original.quotes.length
    )
      throw new ApiError(409, '原卡状态与订单不符，请联系支持核对')
    let available = false
    try {
      const eligibility = await previewReplacement(
        openCredential(original.code, 'inventory', original.id),
        config,
      )
      available =
        eligibility.plan === aicdkPlan(quote.targetPlan) &&
        (!eligibility.expires_at || Date.parse(eligibility.expires_at) > Date.now())
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error
    }
    const stock =
      spare ??
      (available && original.enabled && original.batch?.enabled !== false ? original : null)
    if (!stock) throw new ApiError(409, '暂无可用于补充的库存，请稍后再试或联系支持退款')
    const checked = await preflight(
      openCredential(stock.code, 'inventory', stock.id),
      session,
      config,
      fulfillmentBusiness(quote),
      country ?? undefined,
    )
    if (checked.status !== 'ready')
      throw new UpstreamError('PRICE_REFRESH_PENDING', checked.retry_after ?? 2, false)
    validateFulfillment(checked, quote)

    const now = await databaseNow(client)
    const entry: RefillHistory[number] = {
      createdAt: now.toISOString(),
      requestId,
      redemptionId: previous?.id ?? null,
      version: previous?.version ?? record.redemptionVersion,
      outcome,
      inventoryId: original.id,
      disposition: !spare ? 'reused' : available ? 'returned' : 'held',
      nextInventoryId: stock.id,
      resolution,
    }
    await client.quote.update({
      where: { id: quote.id },
      data: {
        inventoryId: stock.id,
        preflightToken: sealCredential(checked.preflight_token, 'preflight', quote.id),
        preflightExpiresAt: new Date(now.getTime() + 9 * 60_000),
      },
    })
    if (spare)
      await client.inventory.update({
        where: { id: original.id },
        data: { status: available ? 'available' : 'reserved', reservedUntil: null },
      })
    await client.order.update({
      where: { id: orderId },
      data: {
        refillHistory: [...history, entry],
        fulfillmentResolution: Prisma.DbNull,
        status: 'processing',
        redemptionId: null,
        redemptionVersion: 0,
        fulfillmentStatus: null,
        failureReason: null,
        submissionAttempted: false,
        fulfillmentAttempt: { increment: 1 },
      },
    })
    await restartPolling(client, orderId, now)
    await client.audit.create({
      data: {
        id: id('a_'),
        actor: user?.id ?? 'guest',
        action: `申请原单免费补充（第 ${history.length + 1} 次）`,
        target: orderId,
      },
    })
    return true
  }, checkoutTransaction)
  if (!accepted) throw new ApiError(409, '上游未确认原兑换失败或取消，请核对到账情况后联系支持')
  return { accepted: true }
}
