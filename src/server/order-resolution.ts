import { canResolveOrder, orderResolutionInput, orderResolutionSchema } from '../order-resolution'
import { ApiError } from './config'
import { adminOrderView, orderResolutionRevision } from './data'
import { db, transaction, type DbClient } from './db'
import { databaseNow } from './database-sql'
import { audit, completeOrderInTransaction, lockOrderForCompletion } from './services'
import type { Order as OrderRecord } from '../generated/prisma/client'
import type { Redemption } from './integrations/aicdk'

export async function resolveOrder(orderId: string, actor: string, data: unknown) {
  const parsed = orderResolutionInput.safeParse(data)
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '请检查处理信息')
  const input = parsed.data
  await transaction(async (client) => {
    const order = await lockOrderForCompletion(client, orderId)
    if (!order) throw new ApiError(404, '订单不存在')
    if (order.fulfillmentResolution) {
      const previous = orderResolutionSchema.parse(order.fulfillmentResolution)
      // Replaying the same decision after a lost response must not settle twice.
      if (previous.outcome === input.outcome && previous.note === input.note) return
      throw new ApiError(409, '订单已人工处理，请刷新查看处理记录')
    }
    if (!canResolveOrder(order)) throw new ApiError(409, '仅处理中的套餐订单可登记人工结果')
    if (orderResolutionRevision(order) !== input.expectedRevision)
      throw new ApiError(409, '订单状态已更新，请刷新并重新核对后处理')
    await client.order.update({
      where: { id: orderId },
      data: {
        fulfillmentResolution: {
          outcome: input.outcome,
          note: input.note,
          actor,
          createdAt: (await databaseNow(client)).toISOString(),
          previousStatus: order.status,
          previousFulfillmentStatus: order.fulfillmentStatus,
        },
      },
    })
    if (input.outcome === 'completed') await completeOrderInTransaction(client, order)
    else {
      await client.order.update({ where: { id: orderId }, data: { status: 'failed' } })
      if (order.quoteId)
        await client.quote.update({
          where: { id: order.quoteId },
          data: { preflightToken: null },
        })
    }
    // Invalidate any outstanding lease so a worker cannot requeue this decision.
    await client.job.updateMany({
      where: { orderId },
      data: { done: true, lockedUntil: null, lease: null, lastError: null },
    })
    await audit(
      actor,
      input.outcome === 'completed' ? '人工确认兑换成功' : '人工确认兑换失败',
      orderId,
      client,
    )
  })
  return {
    saved: true,
    order: adminOrderView(await db.order.findUniqueOrThrow({ where: { id: orderId } })),
  }
}

// A GET already in flight may arrive after an operator settles the order.
// Preserve the decision and surface a contradictory terminal result for review.
export async function recordResolutionConflict(
  client: DbClient,
  order: OrderRecord,
  result: Redemption,
) {
  if (!order.fulfillmentResolution) return
  const resolution = orderResolutionSchema.parse(order.fulfillmentResolution)
  const outcome =
    result.status === 'completed'
      ? 'completed'
      : ['failed', 'cancelled'].includes(result.status)
        ? 'failed'
        : null
  if (!outcome || outcome === resolution.outcome) return
  if (
    resolution.conflict?.redemptionId === result.id &&
    resolution.conflict.version >= result.version
  )
    return
  await client.order.update({
    where: { id: order.id },
    data: {
      fulfillmentResolution: {
        ...resolution,
        conflict: {
          status: result.status,
          redemptionId: result.id,
          version: result.version,
          detectedAt: (await databaseNow(client)).toISOString(),
        },
      },
    },
  })
  await audit('system', '上游结果与人工结论冲突，待核对', order.id, client)
}
