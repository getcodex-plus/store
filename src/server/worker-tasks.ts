import { db, transaction } from './db'
import { id } from './crypto'
import { safeUpstreamError } from './safe-errors'
import { UpstreamError } from './integrations/aicdk'
import { fulfillOrder } from './fulfillment'
import { deliverOrderEmail } from './notifications'
import { releaseExpiredCouponOrders } from './coupons'
import { claimJob, databaseNow } from './database-sql'

let lastAnalyticsCleanup = 0
export async function tick() {
  const now = await databaseNow()
  if (Date.now() - lastAnalyticsCleanup > 3600000) {
    const cutoff = new Date(now.getTime() - 90 * 86400_000)
    await db.funnelEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
    await db.riskEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } },
    })
    await db.quote.updateMany({
      where: { analyticsVisitor: { not: null }, expiresAt: { lt: cutoff } },
      data: { analyticsVisitor: null },
    })
    lastAnalyticsCleanup = Date.now()
  }
  await deliverOrderEmail()
  await releaseExpiredCouponOrders()
  await db.commission.updateMany({
    where: { status: 'pending', availableAt: { lte: now } },
    data: { status: 'available' },
  })
  await db.authSession.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.authVerification.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.demoMailbox.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.quote.updateMany({
    where: {
      expiresAt: { lt: now },
      preflightToken: { not: null },
      OR: [{ order: null }, { order: { status: { in: ['completed', 'failed', 'refunded'] } } }],
    },
    data: { preflightToken: null },
  })
  const lease = id('lease_')
  const job = await transaction((client) => claimJob(client, lease))
  if (!job) return false
  try {
    if (!(await fulfillOrder(job.orderId))) {
      await db.job.updateMany({
        where: { id: job.id, lease },
        data: {
          runAt: new Date((await databaseNow()).getTime() + 5000),
          lockedUntil: null,
          lastError: null,
        },
      })
      return true
    }
    await db.job.updateMany({
      where: { id: job.id, lease, order: { status: { not: 'processing' } } },
      data: { done: true, lockedUntil: null },
    })
  } catch (error) {
    const safe = error instanceof UpstreamError ? safeUpstreamError(error) : null
    const wait = safe?.retryAfter ?? Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))
    await db.job.updateMany({
      where: { id: job.id, lease },
      data: {
        runAt: new Date((await databaseNow()).getTime() + wait * 1000),
        lockedUntil: null,
        lastError: safe?.code ?? 'RETRY_PENDING',
      },
    })
  }
  return true
}
