import { z } from 'zod'

export const adminQuerySchema = z.object({
  section: z
    .enum([
      'overview',
      'orders',
      'coupons',
      'wallet',
      'users',
      'roles',
      'referral',
      'withdrawals',
      'audit',
      'risk',
    ])
    .default('overview'),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  search: z.string().trim().max(254).default(''),
})

export type AdminQuery = z.infer<typeof adminQuerySchema>
export const adminPageSize = 12
