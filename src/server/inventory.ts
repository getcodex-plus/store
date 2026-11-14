import { z } from 'zod'
import { transaction, type Prisma } from './db'
import { ApiError } from './config'
import { id } from './crypto'
import { lockRow } from './database-sql'
import { openCredential } from './credential-storage'
import { replaceInventory } from './inventory-replacement'
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
  z.object({
    action: z.literal('edit-batch'),
    batchId: itemId,
    name: z.string().trim().min(1).max(80),
    note: z.string().trim().max(300),
  }),
  z.object({ action: z.literal('replace'), id: itemId }).strict(),
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
            batch: { select: { name: true, enabled: true } },
            replacement: { select: { state: true, upstreamCodeId: true } },
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
          batchEnabled: item.batch?.enabled ?? true,
          maskedCode: `•••• ${openCredential(item.code, 'inventory', item.id).slice(-4)}`,
          status: statusOf(item),
          createdAt: item.createdAt.toISOString(),
          replacementState: item.replacement?.state as
            'pending' | 'review' | 'completed' | undefined,
          replacementUpstreamCodeId: item.replacement?.upstreamCodeId ?? undefined,
          manageable: item.status === 'available' && item.quotes.length === 0 && !item.replacement,
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
          return {
            ...batch,
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
  if (input.action === 'replace') return replaceInventory(input.id, actor)
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
    if (input.action === 'enable-batch' || input.action === 'disable-batch') {
      const batch = await client.inventoryBatch.findUnique({ where: { id: input.batchId } })
      if (!batch) throw new ApiError(404, '导入批次不存在')
      // Coordinate with in-flight allocations without changing any other batch.
      await lockRow(client, 'products', batch.productId)
      const enabled = input.action === 'enable-batch'
      await client.inventoryBatch.update({ where: { id: batch.id }, data: { enabled } })
      await client.audit.create({
        data: {
          id: id('a_'),
          actor,
          action: enabled ? '启用导入批次' : '禁用导入批次',
          target: batch.id,
        },
      })
      return { saved: true }
    }
    const ids = [...new Set(input.ids)].sort()
    // Same locks as checkout allocation; sorted ids prevent bulk-action deadlocks.
    for (const itemId of ids) await lockRow(client, 'inventory', itemId)
    const items = await client.inventory.findMany({
      where: { id: { in: ids } },
      include: {
        quotes: { where: attachedOrder, select: { id: true }, take: 1 },
        replacement: true,
      },
    })
    if (items.length !== ids.length) throw new ApiError(404, '兑换码记录不存在，请刷新后重试')
    if (items.some((item) => item.status !== 'available' || item.quotes.length > 0))
      throw new ApiError(409, '已占用或已使用的兑换码不能更改，请刷新列表')
    if (items.some((item) => item.replacement))
      throw new ApiError(409, '换码中的或已更换的旧码不能启用或停用')
    await client.inventory.updateMany({
      where: { id: { in: ids } },
      data: { enabled: input.action === 'enable' },
    })
    await client.audit.create({
      data: {
        id: id('a_'),
        actor,
        action: input.action === 'enable' ? '启用兑换码' : '停用兑换码',
        target: ids.join(','),
      },
    })
    return { saved: true }
  })
}
