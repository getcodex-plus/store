import { z } from 'zod'

export const tawkSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    propertyId: z
      .string()
      .trim()
      .regex(/^(?:[a-f\d]{24})?$/, 'Property ID 应为 24 位小写十六进制字符')
      .default(''),
    widgetId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z\d]{0,64}$/, 'Widget ID 只能包含字母和数字，最长 64 位')
      .default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return
    for (const field of ['propertyId', 'widgetId'] as const) {
      if (!value[field])
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `启用在线客服前请填写 ${field === 'propertyId' ? 'Property ID' : 'Widget ID'}`,
        })
    }
  })

export type TawkSettings = z.infer<typeof tawkSettingsSchema>

export function tawkEmbedSrc(value: unknown) {
  const result = tawkSettingsSchema.safeParse(value)
  if (!result.success || !result.data.enabled) return undefined
  return `https://embed.tawk.to/${result.data.propertyId}/${result.data.widgetId}`
}
