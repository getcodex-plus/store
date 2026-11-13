import { pool, transaction } from './db'
import { demo, validateRuntime } from './config'
import { id } from './crypto'
import { safeUpstreamError } from './safe-errors'
import { UpstreamError } from './integrations/aicdk'
import { fulfillOrder } from './fulfillment'
import { deliverOrderEmail } from './notifications'
import { refreshPendingExchangeRates } from './exchange-rates'

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
    if (!(await fulfillOrder(job.order_id))) {
      await pool.query(
        "UPDATE jobs SET run_at=now()+interval '5 seconds',locked_until=null,last_error=null WHERE id=$1 AND lease=$2",
        [job.id, lease],
      )
      return true
    }
    await pool.query(
      `UPDATE jobs SET done=true,locked_until=null WHERE id=$1 AND lease=$2
      AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=jobs.order_id AND o.status='processing')`,
      [job.id, lease],
    )
  } catch (error) {
    const safe = error instanceof UpstreamError ? safeUpstreamError(error) : null
    const wait = safe?.retryAfter ?? Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))
    await pool.query(
      "UPDATE jobs SET run_at=now()+$3*interval '1 second',locked_until=null,last_error=$4 WHERE id=$1 AND lease=$2",
      [job.id, lease, wait, safe?.code ?? 'RETRY_PENDING'],
    )
  }
  return true
}
console.log('GetCodex Plus worker running; mode:', demo ? 'demo' : 'live')
const exchangeLoop = (async () => {
  while (!stopping) {
    try {
      await refreshPendingExchangeRates()
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
