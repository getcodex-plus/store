import { z } from 'zod'
import { db, Prisma } from './db'
import { orderView, walletEntryView } from './data'

export const accountHistoryQuery = z.object({
  kind: z.enum(['orders', 'ledger']),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  search: z.string().trim().max(254).default(''),
  status: z.enum(['all', 'unpaid', 'processing', 'completed']).default('all'),
})

export async function accountHistory(userId: string, query: z.infer<typeof accountHistoryQuery>) {
  const pageSize = 8
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
  return db.$transaction(
    async (client) => {
      if (query.kind === 'orders') {
        const where: Prisma.OrderWhereInput = {
          userId,
          ...(query.status === 'all'
            ? {}
            : {
                status:
                  query.status === 'processing'
                    ? { in: ['processing', 'needs_session'] }
                    : query.status,
              }),
          ...(query.search
            ? {
                OR: [
                  { id: { contains: query.search, mode: 'insensitive' } },
                  { productName: { contains: query.search, mode: 'insensitive' } },
                  { couponCode: { contains: query.search, mode: 'insensitive' } },
                ],
              }
            : {}),
        }
        const total = await client.order.count({ where })
        const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)))
        const rows = await client.order.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        })
        return { rows: rows.map(orderView), total, page, pageSize }
      }
      const where = { userId }
      const total = await client.walletEntry.count({ where })
      const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)))
      const rows = await client.walletEntry.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      })
      return { rows: rows.map(walletEntryView), total, page, pageSize }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
