import { z } from 'zod'

export const orderResolutionInput = z.object({
  outcome: z.enum(['completed', 'failed']),
  note: z.string().trim().min(1, '请填写核对依据和处理备注').max(1000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, '请刷新订单后重新处理'),
  confirmed: z.literal(true, { error: '请先确认已核对上游和账号的实际结果' }),
})

export const orderResolutionSchema = z.object({
  outcome: z.enum(['completed', 'failed']),
  note: z.string(),
  actor: z.string(),
  createdAt: z.string(),
  previousStatus: z.string(),
  previousFulfillmentStatus: z.string().nullable(),
  conflict: z
    .object({
      status: z.string(),
      redemptionId: z.string(),
      version: z.number().int(),
      detectedAt: z.string(),
    })
    .optional(),
})

export type OrderResolution = z.infer<typeof orderResolutionSchema>

export function canResolveOrder(order: {
  kind: string
  status: string
  fulfillmentStatus?: string | null
}) {
  return (
    order.kind === 'purchase' &&
    order.fulfillmentStatus !== 'awaiting_procurement' &&
    ['processing', 'needs_session'].includes(order.status)
  )
}
