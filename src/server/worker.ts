import { pool, rows, transaction } from './db'
import { demo, validateRuntime } from './config'
import { decrypt, id } from './crypto'
import { aicdk, UpstreamError } from './integrations/aicdk'
import { deliverOrderEmail } from './notifications'
import { completeOrder } from './services'
import type { PaymentOrder } from './integrations/payments'
import { refreshExchangeRate } from './exchange-rates'

validateRuntime()
let stopping = false
let lastAnalyticsCleanup = 0
process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})
async function tick() {
  if (Date.now() - lastAnalyticsCleanup > 3600000) {
    await pool.query("DELETE FROM funnel_events WHERE created_at < now()-interval '90 days'")
    await pool.query(
      "UPDATE quotes SET analytics_visitor=null WHERE analytics_visitor IS NOT NULL AND expires_at < now()-interval '90 days'",
    )
    lastAnalyticsCleanup = Date.now()
  }
  await deliverOrderEmail()
  await pool.query(
    "UPDATE commissions SET status='available' WHERE status='pending' AND available_at<=now()",
  )
  await pool.query('DELETE FROM auth_session WHERE "expiresAt"<now()')
  await pool.query('DELETE FROM auth_verification WHERE "expiresAt"<now()')
  await pool.query('DELETE FROM demo_mailbox WHERE expires_at<now()')
  await pool.query('DELETE FROM rate_limits WHERE expires_at<now()')
  await pool.query(
    "UPDATE quotes q SET preflight_token=null WHERE q.expires_at<now() AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.quote_id=q.id AND o.status NOT IN ('completed','failed','refunded'))",
  )
  const lease = id('lease_')
  const job = await transaction(async (client) => {
    const result = (
      await client.query(
        'SELECT * FROM jobs WHERE done=false AND run_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1',
      )
    ).rows[0]
    if (!result) return null
    await client.query(
      "UPDATE jobs SET locked_until=now()+interval '2 minutes',lease=$2,attempts=attempts+1 WHERE id=$1",
      [result.id, lease],
    )
    return result
  })
  if (!job) return false
  try {
    const order = (await rows<PaymentOrder>('SELECT * FROM orders WHERE id=$1', [job.order_id]))[0]
    if (!order || ['completed', 'refunded', 'failed'].includes(order.status)) {
      await pool.query('UPDATE jobs SET done=true WHERE id=$1 AND lease=$2', [job.id, lease])
      return true
    }
    if (order.status !== 'processing') throw new Error('ORDER_WAITING_FOR_USER')
    if (demo) await completeOrder(order.id)
    else {
      let redemptionId = order.redemptionId
      if (!redemptionId) {
        // Recover an accepted request after a network timeout before attempting the same idempotent submission.
        const recovered = await aicdk<{ id: string }[]>(
          `/redemptions?client_request_id=${encodeURIComponent(order.id)}`,
          undefined,
          undefined,
          order.aicdkIntegrationId,
        )
        redemptionId = recovered[0]?.id
        if (!redemptionId) {
          const quote = (
            await pool.query('SELECT preflight_token FROM quotes WHERE id=$1', [order.quoteId])
          ).rows[0]
          if (!quote?.preflight_token) throw new Error('PREFLIGHT_MISSING')
          const response = await aicdk<{ id: string }>(
            '/redemptions',
            { preflight_token: decrypt(quote.preflight_token), client_request_id: order.id },
            `${order.id}-v${order.fulfillmentAttempt}`,
            order.aicdkIntegrationId,
          )
          redemptionId = response.id
        }
        if (!redemptionId) throw new Error('REDEMPTION_ID_MISSING')
        await pool.query('UPDATE orders SET redemption_id=$2 WHERE id=$1', [order.id, redemptionId])
      }
      const result = await aicdk<{ status: string }>(
        `/redemptions/${encodeURIComponent(redemptionId)}`,
        undefined,
        undefined,
        order.aicdkIntegrationId,
      )
      if (result.status === 'completed') await completeOrder(order.id)
      else if (result.status === 'needs_session')
        await pool.query(
          "UPDATE orders SET status='needs_session' WHERE id=$1 AND status='processing'",
          [order.id],
        )
      else if (['failed', 'cancelled'].includes(result.status))
        await pool.query("UPDATE orders SET status='failed' WHERE id=$1 AND status='processing'", [
          order.id,
        ])
      else throw new Error('REDEMPTION_PENDING')
    }
    await pool.query('UPDATE jobs SET done=true,locked_until=null WHERE id=$1 AND lease=$2', [
      job.id,
      lease,
    ])
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'PREFLIGHT_EXPIRED' && !error.uncertain) {
      await transaction(async (client) => {
        await client.query(
          "UPDATE orders SET status='needs_session' WHERE id=$1 AND status='processing' AND redemption_id IS NULL",
          [job.order_id],
        )
        await client.query(
          'UPDATE jobs SET done=true,locked_until=null,last_error=$3 WHERE id=$1 AND lease=$2',
          [job.id, lease, error.code],
        )
      })
      return true
    }
    const wait =
      error instanceof UpstreamError
        ? error.retryAfter
        : Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))
    await pool.query(
      "UPDATE jobs SET run_at=now()+$3*interval '1 second',locked_until=null,last_error=$4 WHERE id=$1 AND lease=$2",
      [job.id, lease, wait, error instanceof UpstreamError ? error.code : 'RETRY_PENDING'],
    )
  }
  return true
}
console.log('GetCodex Plus worker running; mode:', demo ? 'demo' : 'live')
const exchangeLoop = (async () => {
  while (!stopping) {
    try {
      await Promise.all([refreshExchangeRate(), refreshExchangeRate('USDT')])
    } catch {
      console.error('Exchange rate refresh failed; retrying')
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
})()
while (!stopping) {
  try {
    const worked = await tick()
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 2000))
  } catch {
    console.error('Worker iteration failed; retrying')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}
await exchangeLoop
await pool.end()
