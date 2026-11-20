import { z } from 'zod'
import { redemptionRequestId, refillHistorySchema } from '../order-refill'
import { orderResolutionSchema } from '../order-resolution'
import { ApiError, demo } from './config'
import { hasCompletedInventoryRefund, quoteView, settingsData } from './data'
import { lockRow, lockSettings } from './database-sql'
import { transaction, upstreamTransaction } from './db'
import { validateFulfillment } from './fulfillment-policy'
import { aicdkPlan, findRedemption, getRedemption } from './integrations/aicdk'
import { integration } from './integrations/config'
import { finishReplacement, prepareReplacement } from './inventory-replacement'

const releaseInput = z.strictObject({
  id: z.string().min(1),
  round: z.number().int().nonnegative(),
  inventoryId: z.string().min(1),
  confirmed: z.literal(true),
  reconcile: z.boolean().default(false),
})

export async function releaseOrderInventory(data: unknown, actor: string) {
  const input = releaseInput.parse(data)
  if (demo) throw new ApiError(409, '演示订单不能置换上游卡密')
  await transaction(async (client) => {
    await lockSettings(client, 'share')
    const settings = await client.setting.findUnique({ where: { id: 1 } })
    if (!input.reconcile && (!settings || !settingsData(settings.body).manualInventoryRelease))
      throw new ApiError(409, '后台未开启手动释放订单卡密')
    await lockRow(client, 'orders', input.id)
    const order = await client.order.findUnique({ where: { id: input.id } })
    if (!order?.quoteId || !order.aicdkIntegrationId || order.kind !== 'purchase')
      throw new ApiError(409, '此订单没有可释放的卡密')
    if (!hasCompletedInventoryRefund(order))
      throw new ApiError(409, '退款完成后才能手动释放卡密，请先核对退款记录')
    const history = refillHistorySchema.parse(order.refillHistory)
    const past = history[input.round]
    const current = input.round === history.length
    const resolution = order.fulfillmentResolution
      ? orderResolutionSchema.parse(order.fulfillmentResolution)
      : null
    if (
      (!current && past?.disposition !== 'held') ||
      resolution?.conflict ||
      past?.resolution?.conflict ||
      order.fulfillmentStatus === 'redemption_conflict'
    )
      throw new ApiError(409, '本轮状态不允许释放，请刷新订单并核对兑换和退款结果')

    await lockRow(client, 'quotes', order.quoteId)
    const quote = quoteView(await client.quote.findUniqueOrThrow({ where: { id: order.quoteId } }))
    const sourceId = current ? quote.inventoryId : past.inventoryId
    if (
      sourceId !== input.inventoryId ||
      !quote.targetPlan ||
      quote.productId !== order.productId ||
      quote.email !== order.email ||
      quote.aicdkIntegrationId !== order.aicdkIntegrationId ||
      (!current && quote.inventoryId === sourceId)
    )
      throw new ApiError(409, '库存绑定已变化，请刷新订单')
    await lockRow(client, 'inventory', sourceId)
    const source = await client.inventory.findUniqueOrThrow({
      where: { id: sourceId },
      include: {
        replacement: true,
        quotes: {
          where: { id: { not: quote.id }, order: { is: { status: { not: 'cancelled' } } } },
          take: 1,
          select: { id: true },
        },
      },
    })
    if (
      source.productId !== order.productId ||
      source.discountCountry !== (quote.pricingSnapshot?.fulfillment?.country ?? null) ||
      source.quotes.length
    )
      throw new ApiError(409, '卡密与订单不符或另有占用，未释放库存')
    if (source.replacement) {
      if (source.replacement.orderId === order.id && source.replacement.orderRound === input.round)
        return
      throw new ApiError(409, '卡密已有其他置换记录，请核对库存')
    }
    if (input.reconcile) throw new ApiError(409, '未找到原置换请求，请刷新后核对记录')
    if (source.status !== 'reserved') throw new ApiError(409, '只能释放本单占用的卡密')
    const config = await integration('aicdk', order.aicdkIntegrationId, client)
    const requestId = redemptionRequestId(order.id, input.round)
    const redemptionId = current ? order.redemptionId : past.redemptionId
    const remote = redemptionId
      ? await getRedemption(redemptionId, config)
      : await findRedemption(requestId, config)
    if (remote) {
      validateFulfillment(remote, quote, requestId)
      if (
        remote.version < (current ? order.redemptionVersion : past.version) ||
        !['failed', 'cancelled'].includes(remote.status)
      )
        throw new ApiError(409, '上游未确认本轮兑换已终止，未释放库存')
    } else if (
      current
        ? order.submissionAttempted ||
          redemptionId ||
          order.redemptionVersion !== 0 ||
          (order.fulfillmentStatus && order.fulfillmentStatus !== 'procured') ||
          resolution?.outcome !== 'failed'
        : past.outcome !== 'not_submitted' || redemptionId || past.version !== 0
    ) {
      throw new ApiError(409, '不能确认本轮兑换从未提交，未释放库存')
    }
    await prepareReplacement(client, source, config, actor, {
      orderId: order.id,
      round: input.round,
      plan: aicdkPlan(quote.targetPlan),
    })
  }, upstreamTransaction)
  return finishReplacement(input.inventoryId, actor, '核对释放结果')
}
