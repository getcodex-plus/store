import { z } from 'zod'
import { ApiError, demo } from './config'
import { db, transaction, uniqueConflict } from './db'
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

export async function procurementOverview() {
  const [mappings, purchases] = await Promise.all([
    db.stockMapping.findMany({ orderBy: { productId: 'asc' } }),
    db.stockPurchase.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        productId: true,
        skuId: true,
        quantity: true,
        state: true,
        upstreamOrderId: true,
        lastError: true,
        batchId: true,
        createdAt: true,
      },
    }),
  ])
  return { mappings, purchases }
}

export async function supplierCatalog(page: number) {
  const binding = await integration('dujiao-next')
  const client = dujiaoClient(binding)
  const [info, catalog] = await Promise.all([client.ping(), client.list(page)])
  return { ...catalog, info, integrationId: binding.id }
}

export async function saveStockMapping(raw: unknown, actor: string) {
  const input = mappingInput.parse(raw)
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
          action: '保存进货映射',
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

export async function syncStockPurchase() {
  if (demo) return false
  const purchase = await transaction(claimStockPurchase)
  if (!purchase) return false
  const where = { id: purchase.id, attempts: purchase.attempts, state: purchase.state }
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000)
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
      await db.stockPurchase.updateMany({
        where,
        data: { state: 'review', lastError: status === 'cancelled' ? 'canceled' : status },
      })
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
        await client.stockPurchase.update({
          where: { id: purchase.id },
          data: { batchId: batch.batchId, lastError: null },
        })
      })
    } else {
      await db.stockPurchase.updateMany({ where, data: { nextRunAt: later(15), lastError: null } })
    }
  } catch (error) {
    const data =
      error instanceof PurchaseRejection
        ? { state: 'rejected', lastError: error.code, upstreamOrderId: error.orderId }
        : error instanceof DeliveryMismatch
          ? { state: 'review', lastError: 'delivery_mismatch' }
          : {
              nextRunAt: later(Math.min(300, 5 * 2 ** Math.min(purchase.attempts, 6))),
              lastError: 'retry_pending',
            }
    await db.stockPurchase.updateMany({ where, data })
  }
  return true
}
