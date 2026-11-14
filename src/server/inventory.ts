import { z } from 'zod'
import { transaction, uniqueConflict, type Prisma } from './db'
import { ApiError } from './config'
import { id } from './crypto'
import { lockRow } from './database-sql'
import { inventoryFingerprint, openCredential, sealCredential } from './credential-storage'
import type { InventoryBatchList, InventoryList, InventoryStatus } from '../inventory-types'

const itemId = z.string().min(1).max(64)
export const inventoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  productId: z.string().max(64).optional(),
  batchId: z.string().max(64).optional(),
  status: z.enum(['available', 'disabled', 'reserved', 'consumed']).optional(),
  search: z.string().trim().max(80).default(''),
})
export const inventoryChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['enable', 'disable']), ids: z.array(itemId).min(1).max(100) }),
  z.object({ action: z.literal('enable-batch'), batchId: itemId }),
  z.object({ action: z.literal('disable-batch'), batchId: itemId }),
  z.object({ action: z.literal('activate-batch'), batchId: itemId }),
  z.object({
    action: z.literal('edit-batch'),
    batchId: itemId,
    name: z.string().trim().min(1).max(80),
    note: z.string().trim().max(300),
  }),
  z.object({
    action: z.literal('replace'),
    id: itemId,
    code: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/),
  }),
])
// Match reserveInventory's order exclusion even if a legacy row has the wrong status.
const attachedOrder = { order: { is: { status: { not: 'cancelled' } } } } as const
const emptyCounts = (): InventoryList['counts'] => ({
  available: 0,
  disabled: 0,
  reserved: 0,
  consumed: 0,
})
const statusOf = (item: { status: string; enabled: boolean }) =>
  (item.status === 'available' && !item.enabled ? 'disabled' : item.status) as InventoryStatus

export async function inventoryList(
  input: z.infer<typeof inventoryQuerySchema>,
): Promise<InventoryList> {
  const scope: Prisma.InventoryWhereInput = {
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.search
      ? {
          OR: [
            { id: { contains: input.search, mode: 'insensitive' } },
            { batch: { name: { contains: input.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
  const where: Prisma.InventoryWhereInput = {
    ...scope,
    ...(input.status === 'disabled'
      ? { status: 'available', enabled: false }
      : input.status === 'available'
        ? { status: 'available', enabled: true }
        : input.status
          ? { status: input.status }
          : {}),
  }
  return transaction(
    async (client) => {
      const [records, total, groups] = await Promise.all([
        client.inventory.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          skip: (input.page - 1) * 20,
          include: {
            product: { select: { activeInventoryBatchId: true } },
            batch: { select: { name: true, enabled: true } },
            quotes: { where: attachedOrder, select: { id: true }, take: 1 },
          },
        }),
        client.inventory.count({ where }),
        client.inventory.groupBy({
          by: ['status', 'enabled'],
          where: scope,
          _count: { _all: true },
        }),
      ])
      const counts = emptyCounts()
      for (const group of groups) counts[statusOf(group)] += group._count._all
      return {
        total,
        counts,
        items: records.map((item) => ({
          id: item.id,
          productId: item.productId,
          batchName: item.batch?.name ?? '历史库存',
          batchId: item.batchId,
          currentSupply:
            (item.batch?.enabled ?? true) &&
            (item.product.activeInventoryBatchId === null ||
              item.product.activeInventoryBatchId === item.batchId),
          batchEnabled: item.batch?.enabled ?? true,
          maskedCode: `•••• ${openCredential(item.code, 'inventory', item.id).slice(-4)}`,
          status: statusOf(item),
          createdAt: item.createdAt.toISOString(),
          manageable: item.status === 'available' && item.quotes.length === 0,
        })),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

export async function inventoryBatches(
  input: z.infer<typeof inventoryQuerySchema>,
): Promise<InventoryBatchList> {
  const where: Prisma.InventoryBatchWhereInput = {
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.search
      ? {
          OR: [
            { name: { contains: input.search, mode: 'insensitive' } },
            { id: { contains: input.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
  return transaction(
    async (client) => {
      const [batches, total] = await Promise.all([
        client.inventoryBatch.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          skip: (input.page - 1) * 20,
          include: { product: { select: { activeInventoryBatchId: true } } },
        }),
        client.inventoryBatch.count({ where }),
      ])
      const groups = await client.inventory.groupBy({
        by: ['batchId', 'status', 'enabled'],
        where: { batchId: { in: batches.map((batch) => batch.id) } },
        _count: { _all: true },
      })
      return {
        total,
        items: batches.map((batch) => {
          const counts = emptyCounts()
          for (const group of groups)
            if (group.batchId === batch.id) counts[statusOf(group)] += group._count._all
          const { product, ...fields } = batch
          return {
            ...fields,
            active: product.activeInventoryBatchId === batch.id,
            createdAt: batch.createdAt.toISOString(),
            counts,
          }
        }),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

export async function changeInventory(input: z.infer<typeof inventoryChangeSchema>, actor: string) {
  return transaction(async (client) => {
    if (input.action === 'edit-batch') {
      const result = await client.inventoryBatch.updateMany({
        where: { id: input.batchId },
        data: { name: input.name, note: input.note },
      })
      if (!result.count) throw new ApiError(404, '导入批次不存在')
      await client.audit.create({
        data: { id: id('a_'), actor, action: '编辑导入批次', target: input.batchId },
      })
      return { saved: true }
    }
    if (
      input.action === 'activate-batch' ||
      input.action === 'enable-batch' ||
      input.action === 'disable-batch'
    ) {
      const batch = await client.inventoryBatch.findUnique({ where: { id: input.batchId } })
      if (!batch) throw new ApiError(404, '导入批次不存在')
      await lockRow(client, 'products', batch.productId)
      if (input.action === 'disable-batch') {
        await client.inventoryBatch.update({ where: { id: batch.id }, data: { enabled: false } })
        await client.audit.create({
          data: { id: id('a_'), actor, action: '禁用导入批次', target: batch.id },
        })
        return { saved: true }
      }
      if (
        !(await client.inventory.count({
          where: {
            batchId: batch.id,
            enabled: true,
            status: 'available',
            quotes: { none: attachedOrder },
          },
        }))
      )
        throw new ApiError(409, '此批次没有可用兑换码，请先导入或启用库存')
      await client.inventoryBatch.updateMany({
        where: { productId: batch.productId, id: { not: batch.id } },
        data: { enabled: false },
      })
      await client.inventoryBatch.update({ where: { id: batch.id }, data: { enabled: true } })
      await client.product.update({
        where: { id: batch.productId },
        data: { activeInventoryBatchId: batch.id },
      })
      await client.audit.create({
        data: {
          id: id('a_'),
          actor,
          action: '切换商品供货批次',
          target: `${batch.productId}:${batch.id}`,
        },
      })
      return { saved: true }
    }
    const ids = [...new Set(input.action === 'replace' ? [input.id] : input.ids)].sort()
    // Same locks as checkout allocation; sorted ids prevent bulk-action deadlocks.
    for (const itemId of ids) await lockRow(client, 'inventory', itemId)
    const items = await client.inventory.findMany({
      where: { id: { in: ids } },
      include: { quotes: { where: attachedOrder, select: { id: true }, take: 1 } },
    })
    if (items.length !== ids.length) throw new ApiError(404, '兑换码记录不存在，请刷新后重试')
    if (items.some((item) => item.status !== 'available' || item.quotes.length > 0))
      throw new ApiError(409, '已占用或已使用的兑换码不能更改，请刷新列表')
    let replacementId: string | undefined
    if (input.action === 'replace') {
      const previous = items[0]
      if (await client.inventory.count({ where: { NOT: { code: { startsWith: 'v2:' } } } }))
        throw new ApiError(503, '凭据存储需要升级，请联系管理员执行数据库迁移')
      replacementId = id('i_')
      await client.inventory.create({
        data: {
          id: replacementId,
          productId: previous.productId,
          batchId: previous.batchId,
          code: sealCredential(input.code, 'inventory', replacementId),
          fingerprint: inventoryFingerprint(input.code),
        },
      })
      await client.inventory.update({ where: { id: previous.id }, data: { enabled: false } })
    } else {
      await client.inventory.updateMany({
        where: { id: { in: ids } },
        data: { enabled: input.action === 'enable' },
      })
    }
    await client.audit.create({
      data: {
        id: id('a_'),
        actor,
        action:
          input.action === 'replace'
            ? '更换兑换码'
            : input.action === 'enable'
              ? '启用兑换码'
              : '停用兑换码',
        target: [...ids, ...(replacementId ? [replacementId] : [])].join(','),
      },
    })
    return { saved: true, replacementId }
  }).catch((error) => {
    if (uniqueConflict(error)) throw new ApiError(409, '此兑换码已在库存中，请使用其他兑换码')
    throw error
  })
}
