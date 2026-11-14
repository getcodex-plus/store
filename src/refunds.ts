import { z } from 'zod'
import type { AdminOrder, OrderRefund } from './types'

// Longer than the channel's 20-second request timeout. Expired requests may only
// be reconciled by an administrator, never sent to the payment provider again.
export const refundReviewDelayMs = 60_000
export const refundInputSchema = z
  .object({
    destination: z.enum(['wallet', 'original']),
    automatic: z.boolean(),
    note: z.string().trim().max(1000, '退款备注最多 1000 字').default(''),
    reconcile: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if ((input.destination === 'original' && !input.automatic) || input.reconcile) {
      if (!input.note)
        ctx.addIssue({ code: 'custom', path: ['note'], message: '请填写手动退款处理备注' })
    }
    if (input.automatic && (input.destination !== 'original' || input.reconcile))
      ctx.addIssue({ code: 'custom', path: ['automatic'], message: '此操作不支持自动退款' })
  })
export type RefundInput = z.infer<typeof refundInputSchema>
export const supportsAutomaticRefund = (order: Pick<AdminOrder, 'provider' | 'externalAmount'>) =>
  order.provider === 'xorpay' && order.externalAmount > 0
export function refundNeedsReview(refund: OrderRefund, now = Date.now()) {
  return (
    refund.status === 'review' ||
    (refund.status === 'processing' &&
      now - new Date(refund.requestedAt).getTime() >= refundReviewDelayMs)
  )
}
