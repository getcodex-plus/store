import { z } from 'zod'
import { ApiError, demo } from './config'
import { db, transaction, uniqueConflict, type DbClient } from './db'
import { advisoryLock, claimStockPurchase, lockIntegration } from './database-sql'
import { integration } from './integrations/config'
import { dujiaoClient, PurchaseRejection, upstreamId } from './integrations/dujiao'
import { importInventoryBatch } from './credential-storage'
import { inventoryImportLimit, parseInventoryText } from '../inventory-import'
import { id } from './crypto'

const localId = z.string().regex(/^[a-z\d_-]{1,64}$/)
const mappingInput = z.object({
  productId: localId,
  upstreamProductId: upstreamId,
  skuId: upstreamId,
  integrationId: z.string().min(1).max(100),
})
const purchaseInput = mappingInput.extend({
  requestKey: z.uuid(),
  quantity: z.number().int().min(1).max(inventoryImportLimit),
})

const procurementQuery = z.object({
  state: z.enum(['queued', 'polling', 'review', 'rejected', 'received']).optional(),
  before: z.string().min(1).max(64).optional(),
})

export async function procurementOverview(raw?: unknown) {
  const filter = procurementQuery.parse(raw ?? {})
  const where = filter.state ? { state: filter.state } : {}
  const [mappings, rows, reviewCount] = await Promise.all([
    db.stockMapping.findMany({ orderBy: { productId: 'asc' } }),
    db.stockPurchase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One row past the page so the client can tell whether older records exist;
      // a fixed `take: 50` alone hides any review row that 50 newer purchases
      // pushed off the end, and "需人工核对" then silently looks empty.
      take: 51,
      ...(filter.before ? { cursor: { id: filter.before }, skip: 1 } : {}),
      select: {
        id: true,
        orderId: true,
        productId: true,
        skuId: true,
        quantity: true,
        state: true,
        upstreamOrderId: true,
        lastError: true,
        batchId: true,
        attempts: true,
        nextRunAt: true,
        actor: true,
        createdAt: true,
      },
    }),
    // Counted over the whole table, never over the visible page.
    db.stockPurchase.count({ where: { state: 'review' } }),
  ])
  return {
    mappings,
    purchases: rows.slice(0, 50),
    hasMore: rows.length > 50,
    reviewCount,
  }
}

export async function supplierCatalog(page: number) {
  const binding = await integration('dujiao-next')
  const client = dujiaoClient(binding)
  const [info, catalog] = await Promise.all([client.ping(), client.list(page)])
  return { ...catalog, info, integrationId: binding.id }
}

export async function saveStockMapping(raw: unknown, actor: string) {
  const input = mappingInput.extend({ purchaseAfterPayment: z.boolean().default(false) }).parse(raw)
  if (demo && input.purchaseAfterPayment) throw new ApiError(409, '演示模式不能启用付款后按单采购')
  const binding = await integration('dujiao-next')
  if (binding.id !== input.integrationId) throw new ApiError(409, '上游配置已变更，请刷新目录')
  const product = await dujiaoClient(binding).product(input.upstreamProductId)
  if (
    !product.is_active ||
    product.fulfillment_type !== 'auto' ||
    !product.skus.some((sku) => sku.id === input.skuId && sku.is_active)
  )
    throw new ApiError(409, '请选择上架的自动发卡商品及其有效 SKU')
  try {
    return await transaction(async (client) => {
      await lockIntegration(client, 'dujiao-next')
      if ((await integration('dujiao-next', undefined, client)).id !== binding.id)
        throw new ApiError(409, '上游配置已变更，请刷新目录')
      if (!(await client.product.findFirst({ where: { id: input.productId, upgrade: false } })))
        throw new ApiError(404, '本地充值套餐不存在')
      await client.stockMapping.upsert({
        where: { productId: input.productId },
        create: input,
        update: input,
      })
      await client.audit.create({
        data: {
          id: id('a_'),
          actor,
          action: input.purchaseAfterPayment ? '启用付款后按单采购' : '保存手动进货映射',
          target: `${input.productId}:${input.skuId}`,
        },
      })
      return { saved: true }
    })
  } catch (error) {
    if (uniqueConflict(error)) throw new ApiError(409, '此 SKU 已映射到其他套餐')
    throw error
  }
}

export async function paidOrderMapping(productId: string, client: DbClient = db) {
  const mapping = await client.stockMapping.findFirst({
    where: { productId, purchaseAfterPayment: true },
    include: { integration: { select: { active: true, enabled: true } } },
  })
  if (!mapping) return undefined
  if (!mapping.integration.active || !mapping.integration.enabled)
    throw new ApiError(409, '此套餐供货配置已变更，请联系支持')
  const { integrationId, upstreamProductId, skuId } = mapping
  return { integrationId, upstreamProductId, skuId }
}

export async function queueStockPurchase(raw: unknown, actor: string) {
  const { requestKey, quantity, ...input } = purchaseInput.parse(raw)
  if (demo) throw new ApiError(409, '演示模式不会向上游采购或扣款')
  return transaction(async (client) => {
    await advisoryLock(client, `stock:${requestKey}`)
    const existing = await client.stockPurchase.findUnique({ where: { id: requestKey } })
    if (existing) {
      if (
        existing.productId !== input.productId ||
        existing.skuId !== input.skuId ||
        existing.upstreamProductId !== input.upstreamProductId ||
        existing.integrationId !== input.integrationId ||
        existing.quantity !== quantity ||
        existing.actor !== actor
      )
        throw new ApiError(409, '同一采购请求不能更改参数')
      return { id: existing.id }
    }
    await lockIntegration(client, 'dujiao-next')
    const active = await integration('dujiao-next', undefined, client)
    const mapping = await client.stockMapping.findFirst({
      where: { ...input, product: { upgrade: false } },
    })
    if (!mapping || mapping.integrationId !== active.id)
      throw new ApiError(409, '商品映射或上游凭证已更改，请重新确认')
    await client.stockPurchase.create({ data: { ...input, id: requestKey, quantity, actor } })
    await client.audit.create({
      data: { id: id('a_'), actor, action: '提交进货采购', target: requestKey },
    })
    return { id: requestKey }
  })
}

export async function removeStockMapping(raw: unknown, actor: string) {
  const input = mappingInput.parse(raw)
  return transaction(async (client) => {
    const result = await client.stockMapping.deleteMany({ where: input })
    if (!result.count) throw new ApiError(409, '映射已变更，请刷新后重试')
    await client.audit.create({
      data: { id: id('a_'), actor, action: '移除进货映射', target: input.productId },
    })
    return { saved: true }
  })
}

class DeliveryMismatch extends Error {}

export async function resyncPaidPurchase(raw: unknown, actor: string) {
  const { id: purchaseId } = z.object({ id: z.string().min(1) }).parse(raw)
  if (demo) throw new ApiError(409, '演示模式不会向上游采购或扣款')
  return transaction(async (client) => {
    const purchase = await client.stockPurchase.findUnique({ where: { id: purchaseId } })
    if (!purchase?.orderId || purchase.state !== 'review')
      throw new ApiError(409, '只能核对待人工处理的按单采购')
    const resumed = await client.order.updateMany({
      where: {
        id: purchase.orderId,
        status: 'processing',
        fulfillmentStatus: 'procurement_review',
      },
      data: { fulfillmentStatus: 'awaiting_procurement' },
    })
    if (!resumed.count) throw new ApiError(409, '原订单已处理或正在同步')
    await client.stockPurchase.update({
      where: { id: purchaseId },
      data: {
        state: purchase.upstreamOrderId ? 'polling' : 'queued',
        nextRunAt: new Date(),
        lastError: null,
      },
    })
    await client.audit.create({
      data: { id: id('a_'), actor, action: '核对原单采购', target: purchaseId },
    })
    return { saved: true }
  })
}

export async function syncStockPurchase() {
  if (demo) return false
  const purchase = await transaction(claimStockPurchase)
  if (!purchase) return false
  const where = { id: purchase.id, attempts: purchase.attempts, state: purchase.state }
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000)
  // Two budgets, because the two phases fail differently.
  //
  // Before an upstream order exists, every claim is a failed attempt: 20 backoff
  // rounds (5s→300s ≈ 25 min) then a human. The old
  // `purchase.orderId && attempts >= 60` also required `orderId` — null while no
  // order is linked — so a create() that kept throwing retried forever.
  //
  // Once an upstream order exists, `attempts` keeps incrementing on every healthy
  // poll, so it must NOT be charged against a failure budget (a 19-poll order
  // hitting one 502 would otherwise jump straight to a human). That phase is
  // bounded by elapsed polling instead: 120 polls at 15s ≈ 30 min, then
  // stale_upstream.
  const exhausted = !purchase.upstreamOrderId && purchase.attempts >= 20
  const stale = !!purchase.upstreamOrderId && purchase.attempts >= 120
  const stop = (state: 'review' | 'rejected', lastError: string, upstreamOrderId?: number) =>
    transaction(async (client) => {
      const claimed = await client.stockPurchase.updateMany({
        where,
        data: { state, lastError, upstreamOrderId },
      })
      if (!claimed.count || !purchase.orderId) return
      await client.order.updateMany({
        where: {
          id: purchase.orderId,
          status: 'processing',
          fulfillmentStatus: 'awaiting_procurement',
        },
        data:
          state === 'rejected'
            ? { status: 'failed', fulfillmentStatus: 'procurement_rejected' }
            : { fulfillmentStatus: 'procurement_review' },
      })
    })
  try {
    const supplier = dujiaoClient(await integration('dujiao-next', purchase.integrationId))
    if (!purchase.upstreamOrderId) {
      const created = await supplier.create(purchase.id, purchase.skuId, purchase.quantity)
      await db.stockPurchase.updateMany({
        where,
        data: {
          upstreamOrderId: created.order_id,
          state: 'polling',
          nextRunAt: later(0),
          lastError: null,
        },
      })
      return true
    }
    const result = await supplier.order(purchase.upstreamOrderId)
    const status = result.status.trim().toLowerCase()
    if (['canceled', 'cancelled', 'refunded', 'partially_refunded'].includes(status)) {
      await stop('review', status === 'cancelled' ? 'canceled' : status)
    } else if (['delivered', 'completed', 'fulfilled'].includes(status)) {
      if (
        !result.fulfillment ||
        !['auto', 'upstream'].includes(result.fulfillment.type) ||
        result.fulfillment.status !== 'delivered' ||
        (result.items &&
          (result.items.length !== 1 ||
            result.items[0].product_id !== purchase.upstreamProductId ||
            result.items[0].sku_id !== purchase.skuId ||
            result.items[0].quantity !== purchase.quantity))
      )
        throw new DeliveryMismatch()
      let codes: string[]
      try {
        codes = parseInventoryText(result.fulfillment.payload)
      } catch {
        throw new DeliveryMismatch()
      }
      if (codes.length !== purchase.quantity) throw new DeliveryMismatch()
      await transaction(async (client) => {
        const claimed = await client.stockPurchase.updateMany({
          where,
          data: { state: 'received' },
        })
        if (!claimed.count) return
        const batch = await importInventoryBatch(
          client,
          purchase.productId,
          codes,
          purchase.actor,
          {
            batchName: `Dujiao-Next #${purchase.upstreamOrderId}`,
            note: `采购单 ${purchase.id}`,
          },
        )
        if (batch.duplicates) throw new DeliveryMismatch()
        if (purchase.orderId) {
          const order = await client.order.findUniqueOrThrow({ where: { id: purchase.orderId } })
          if (!order.quoteId || order.productId !== purchase.productId) throw new DeliveryMismatch()
          const ready = await client.order.updateMany({
            where: {
              id: order.id,
              status: 'processing',
              fulfillmentStatus: 'awaiting_procurement',
            },
            data: { status: 'needs_session', fulfillmentStatus: 'procured' },
          })
          if (!ready.count) throw new DeliveryMismatch()
          const stock = await client.inventory.findFirstOrThrow({
            where: { batchId: batch.batchId },
          })
          await client.inventory.update({ where: { id: stock.id }, data: { status: 'reserved' } })
          const bound = await client.quote.updateMany({
            where: { id: order.quoteId, productId: purchase.productId, inventoryId: null },
            data: { inventoryId: stock.id },
          })
          if (!bound.count) throw new DeliveryMismatch()
        }
        await client.stockPurchase.update({
          where: { id: purchase.id },
          data: { batchId: batch.batchId, lastError: null },
        })
      })
    } else if (stale) {
      await stop('review', 'stale_upstream')
    } else {
      await db.stockPurchase.updateMany({ where, data: { nextRunAt: later(15), lastError: null } })
    }
  } catch (error) {
    if (error instanceof PurchaseRejection) await stop('rejected', error.code, error.orderId)
    else if (error instanceof DeliveryMismatch) await stop('review', 'delivery_mismatch')
    else if (exhausted) await stop('review', 'retry_exhausted')
    else
      await db.stockPurchase.updateMany({
        where,
        data: {
          nextRunAt: later(Math.min(300, 5 * 2 ** Math.min(purchase.attempts, 6))),
          lastError: 'retry_pending',
        },
      })
  }
  return true
}
