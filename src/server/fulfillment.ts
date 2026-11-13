import { pool, rows, transaction } from './db'
import { demo } from './config'
import { openCredential } from './credential-storage'
import { completeOrder, type StoredQuote } from './services'
import { validateFulfillment } from './fulfillment-policy'
import type { PaymentOrder } from './integrations/payments'
import {
  findRedemption,
  getRedemption,
  submitRedemption,
  resolveAicdk,
  UpstreamError,
  type Redemption,
} from './integrations/aicdk'

async function needSession(order: PaymentOrder) {
  await transaction(async (client) => {
    const updated = await client.query(
      "UPDATE orders SET status='needs_session',submission_attempted=false WHERE id=$1 AND status='processing' AND redemption_id IS NULL AND fulfillment_attempt=$2 RETURNING quote_id",
      [order.id, order.fulfillmentAttempt],
    )
    if (updated.rowCount)
      await client.query('UPDATE quotes SET preflight_token=null WHERE id=$1', [order.quoteId])
  })
}

async function recordResult(order: PaymentOrder, quote: StoredQuote, result: Redemption) {
  validateFulfillment(result, quote, order.id)
  const accepted = await transaction(async (client) => {
    const current = (
      await rows<PaymentOrder>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [order.id], client)
    )[0]
    if (!current || !['processing', 'needs_session'].includes(current.status)) return false
    if (
      (current.redemptionId && current.redemptionId !== result.id) ||
      result.version < current.redemptionVersion ||
      (current.redemptionId &&
        current.fulfillmentStatus &&
        result.version === current.redemptionVersion &&
        current.fulfillmentStatus !== result.status)
    )
      throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
    const status =
      result.status === 'needs_session'
        ? 'needs_session'
        : ['failed', 'cancelled'].includes(result.status)
          ? 'failed'
          : 'processing'
    await client.query(
      'UPDATE orders SET redemption_id=$2,redemption_version=$3,fulfillment_status=$4,status=$5 WHERE id=$1',
      [order.id, result.id, result.version, result.status, status],
    )
    // A known upstream order is recovered by ID from now on; the ticket is obsolete.
    await client.query('UPDATE quotes SET preflight_token=null WHERE id=$1', [quote.id])
    return true
  })
  if (accepted && result.status === 'completed') await completeOrder(order.id)
  return !accepted || ['completed', 'failed', 'cancelled', 'needs_session'].includes(result.status)
}

// Returns true only when this job can stop polling. Network ambiguity never
// releases a card, refunds an order, or changes the submission key/body.
export async function fulfillOrder(orderId: string): Promise<boolean> {
  const order = (await rows<PaymentOrder>('SELECT * FROM orders WHERE id=$1', [orderId]))[0]
  if (
    !order ||
    ['completed', 'failed', 'refunded', 'cancelled', 'needs_session'].includes(order.status)
  )
    return true
  if (order.status !== 'processing') return false
  if (demo) {
    await completeOrder(order.id)
    return true
  }
  if (!order.aicdkIntegrationId) throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
  const binding = await resolveAicdk(order.aicdkIntegrationId)
  const quote = (await rows<StoredQuote>('SELECT * FROM quotes WHERE id=$1', [order.quoteId]))[0]
  if (!quote) throw new UpstreamError('UPSTREAM_INVALID_RESPONSE', 30, true)
  let result = order.redemptionId
    ? await getRedemption(order.redemptionId, binding)
    : await findRedemption(order.id, binding)
  if (!result) {
    const expired = !quote.preflightExpiresAt || Date.parse(quote.preflightExpiresAt) <= Date.now()
    if ((!quote.preflightToken || expired) && !order.submissionAttempted) {
      await needSession(order)
      return true
    }
    // An attempted request may have reached AICDK. Even an expired ticket must
    // be replayed unchanged; its durable receipt may contain the accepted order.
    if (!quote.preflightToken) throw new UpstreamError('OUTCOME_UNKNOWN', 30, true)
    const claimed = await pool.query(
      "UPDATE orders SET submission_attempted=true WHERE id=$1 AND status='processing' AND redemption_id IS NULL AND fulfillment_attempt=$2 RETURNING id",
      [order.id, order.fulfillmentAttempt],
    )
    if (!claimed.rowCount) return false
    try {
      result = await submitRedemption(
        openCredential(quote.preflightToken, 'preflight', quote.id),
        order.id,
        `${order.id}-v${order.fulfillmentAttempt}`,
        binding,
      )
    } catch (error) {
      // Current AICDK maps an expired/missing preflight to 422 OPERATION_NOT_READY
      // or 404 NOT_FOUND. These definitive, recorded rejections permit refreshing
      // credentials; an uncertain response never does.
      if (
        error instanceof UpstreamError &&
        !error.uncertain &&
        error.status >= 400 &&
        error.status < 500 &&
        [
          'PREFLIGHT_EXPIRED',
          'OPERATION_NOT_READY',
          'NOT_FOUND',
          'PRICE_REFRESH_PENDING',
          'SESSION_TOKEN_EXPIRED',
        ].includes(error.code)
      ) {
        result = await findRedemption(order.id, binding)
        if (!result) {
          await needSession(order)
          return true
        }
      } else {
        if (error instanceof UpstreamError && error.uncertain)
          await pool.query(
            "UPDATE orders SET fulfillment_status='uncertain' WHERE id=$1 AND status='processing' AND redemption_id IS NULL",
            [order.id],
          )
        throw error
      }
    }
  }
  return recordResult(order, quote, result)
}
