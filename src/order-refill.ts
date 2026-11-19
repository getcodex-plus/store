import { z } from 'zod'
import { orderResolutionSchema } from './order-resolution'

export const refillInput = z.strictObject({
  round: z.number().int().nonnegative(),
  confirmedNotReceived: z.literal(true),
  session: z.string().min(1).max(100000),
})

export const refillHistorySchema = z.array(
  z.object({
    createdAt: z.string(),
    requestId: z.string(),
    redemptionId: z.string().nullable(),
    version: z.number().int(),
    outcome: z.enum(['failed', 'cancelled', 'not_submitted']),
    inventoryId: z.string(),
    disposition: z.enum(['returned', 'held', 'reused']),
    nextInventoryId: z.string(),
    resolution: orderResolutionSchema.nullable(),
  }),
)
export type RefillHistory = z.infer<typeof refillHistorySchema>

export function redemptionRequestId(orderId: string, round = 0) {
  return round === 0 ? orderId : `${orderId}-r${round}`
}
