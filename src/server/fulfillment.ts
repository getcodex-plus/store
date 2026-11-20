import { db, transaction, upstreamTransaction, type DbClient } from './db'
import { redemptionRequestId } from '../order-refill'
import { paymentOrderView, quoteView } from './data'
import { demo } from './config'
import { openCredential } from './credential-storage'
import {
  completeOrder,
  completeOrderInTransaction,
  lockOrderForCompletion,
  type StoredQuote,
} from './services'
import { recordResolutionConflict } from './order-resolution'
import type { Order as OrderRecord } from '../generated/prisma/client'
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

async function needSession(order: PaymentOrder, tx?: DbClient) {
  const update = async (client: DbClient) => {
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
  }
  if (tx) await update(tx)
  else await transaction(update)
}

async function recordResult(
  client: DbClient,
  record: OrderRecord,
  quote: StoredQuote,
  result: Redemption,
  requestId: string,
) {
  const current = paymentOrderView(record)
  if (redemptionRequestId(current.id, current.refillCount) !== requestId) return false
  validateFulfillment(result, quote, requestId)
  if (record.fulfillmentResolution) {
    if (
      (!record.redemptionId || record.redemptionId === result.id) &&
      result.version >= record.redemptionVersion
    )
      await recordResolutionConflict(client, record, result)
    return true
  }
  if (!['processing', 'needs_session'].includes(record.status)) return true
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
    where: { id: record.id },
    data: {
      redemptionId: result.id,
      redemptionVersion: result.version,
      fulfillmentStatus: result.status,
      status,
    },
  })
  await client.quote.update({ where: { id: quote.id }, data: { preflightToken: null } })
  if (result.status === 'completed') await completeOrderInTransaction(client, record)
  return ['completed', 'failed', 'cancelled', 'needs_session'].includes(result.status)
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
  // awaiting_procurement / procurement_review wait on other systems; those are
  // local marks. redemption_conflict is our own stop mark: upstream already holds
  // more than one redemption, so no further submission is safe.
  // requires_action is deliberately NOT here: the provider uses it for
  // manual_review, and such a redemption has an id and can still complete
  // upstream, so those orders keep their read-only poll.
  if (
    ['awaiting_procurement', 'procurement_review', 'redemption_conflict'].includes(
      order.fulfillmentStatus ?? '',
    )
  )
    return false
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
  const requestId = redemptionRequestId(order.id, order.refillCount)
  let result: Redemption | undefined
  try {
    result = order.redemptionId
      ? await getRedemption(order.redemptionId, binding)
      : await findRedemption(requestId, binding)
  } catch (error) {
    // Upstream already holds more than one redemption for this request. Any
    // retry would create another one, so mark the order for a human and stop
    // without touching upstream again.
    if (error instanceof UpstreamError && error.code === 'REDEMPTION_CONFLICT') {
      await transaction(async (client) => {
        // This lookup ran outside the order lock, so the conflict may belong to a
        // round that a human has since failed and refilled. Match the round
        // atomically: only while the order is still processing on THIS round does
        // the mark apply — and only then may the job be closed. Otherwise a late
        // response would park a fresh, healthy refill.
        const marked = await client.$executeRaw`
          UPDATE orders SET fulfillment_status = 'redemption_conflict'
          WHERE id = ${order.id}
            AND status = 'processing'
            AND jsonb_array_length(refill_history) = ${order.refillCount}
        `
        if (!marked) return
        // Returning true alone does not close the job: tick() sets job.done only
        // when order.status leaves 'processing', and this order stays there on
        // purpose — without this the worker re-claims it every few seconds.
        await client.job.updateMany({
          where: { orderId: order.id },
          data: { done: true, lockedUntil: null, lastError: 'REDEMPTION_CONFLICT' },
        })
      })
      return true
    }
    throw error
  }
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
    // The attempted flag is durable before sending. Hold the order lock from the
    // last state check through submission and settlement, excluding manual decisions.
    // A crash rolls back this transaction, but not the attempted flag or original ticket.
    const attempt = await transaction(async (client) => {
      const current = await lockOrderForCompletion(client, order.id)
      if (!current || !['processing', 'needs_session'].includes(current.status))
        return { done: true }
      if (
        current.status !== 'processing' ||
        current.fulfillmentAttempt !== order.fulfillmentAttempt ||
        current.redemptionId
      )
        return { done: false }
      let submitted: Redemption
      try {
        submitted = await submitRedemption(
          openCredential(quote.preflightToken!, 'preflight', quote.id),
          requestId,
          `${requestId}-v${order.fulfillmentAttempt}`,
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
          let recovered: Redemption | undefined
          try {
            recovered = await findRedemption(requestId, binding)
          } catch (recoverError) {
            // Same definitive stop as the pre-submit lookup: never add a second
            // redemption when upstream already reports more than one.
            if (
              recoverError instanceof UpstreamError &&
              recoverError.code === 'REDEMPTION_CONFLICT'
            ) {
              // Same round check as the pre-submit path: the recovery lookup may
              // have been answered for a round that is no longer live.
              const marked = await client.$executeRaw`
                UPDATE orders SET fulfillment_status = 'redemption_conflict'
                WHERE id = ${order.id}
                  AND status = 'processing'
                  AND jsonb_array_length(refill_history) = ${order.refillCount}
              `
              if (!marked) return { done: true }
              await client.job.updateMany({
                where: { orderId: order.id },
                data: { done: true, lockedUntil: null, lastError: 'REDEMPTION_CONFLICT' },
              })
              return { done: true }
            }
            throw recoverError
          }
          if (!recovered) {
            await needSession(order, client)
            return { done: true }
          }
          submitted = recovered
        } else {
          if (error instanceof UpstreamError && error.uncertain)
            await client.order.updateMany({
              where: { id: order.id, status: 'processing', redemptionId: null },
              data: { fulfillmentStatus: 'uncertain' },
            })
          return { error }
        }
      }
      return { done: await recordResult(client, current, quote, submitted, requestId) }
    }, upstreamTransaction)
    if ('error' in attempt) throw attempt.error
    return attempt.done
  }
  return transaction(async (client) => {
    const current = await lockOrderForCompletion(client, order.id)
    return current ? recordResult(client, current, quote, result, requestId) : true
  })
}
