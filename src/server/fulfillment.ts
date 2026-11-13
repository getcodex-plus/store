import { db, transaction } from './db'
import { paymentOrderView, quoteView } from './data'
import { lockRow } from './database-sql'
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
    const updated = await client.order.updateMany({
      where: {
        id: order.id,
        status: 'processing',
        redemptionId: null,
        fulfillmentAttempt: order.fulfillmentAttempt,
      },
      data: { status: 'needs_session', submissionAttempted: false },
    })
    if (updated.count && order.quoteId)
      await client.quote.updateMany({
        where: { id: order.quoteId },
        data: { preflightToken: null },
      })
  })
}

async function recordResult(order: PaymentOrder, quote: StoredQuote, result: Redemption) {
  validateFulfillment(result, quote, order.id)
  const accepted = await transaction(async (client) => {
    await lockRow(client, 'orders', order.id)
    const record = await client.order.findUnique({ where: { id: order.id } })
    if (!record || !['processing', 'needs_session'].includes(record.status)) return false
    const current = paymentOrderView(record)
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
    await client.order.update({
      where: { id: order.id },
      data: {
        redemptionId: result.id,
        redemptionVersion: result.version,
        fulfillmentStatus: result.status,
        status,
      },
    })
    await client.quote.update({ where: { id: quote.id }, data: { preflightToken: null } })
    return true
  })
  if (accepted && result.status === 'completed') await completeOrder(order.id)
  return !accepted || ['completed', 'failed', 'cancelled', 'needs_session'].includes(result.status)
}

// Returns true only when this job can stop polling. Network ambiguity never
// releases a card, refunds an order, or changes the submission key/body.
export async function fulfillOrder(orderId: string): Promise<boolean> {
  const stored = await db.order.findUnique({ where: { id: orderId } })
  const order = stored ? paymentOrderView(stored) : null
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
  const storedQuote = order.quoteId
    ? await db.quote.findUnique({ where: { id: order.quoteId } })
    : null
  const quote = storedQuote ? quoteView(storedQuote) : null
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
    const claimed = await db.order.updateMany({
      where: {
        id: order.id,
        status: 'processing',
        redemptionId: null,
        fulfillmentAttempt: order.fulfillmentAttempt,
      },
      data: { submissionAttempted: true },
    })
    if (!claimed.count) return false
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
          await db.order.updateMany({
            where: { id: order.id, status: 'processing', redemptionId: null },
            data: { fulfillmentStatus: 'uncertain' },
          })
        throw error
      }
    }
  }
  return recordResult(order, quote, result)
}
