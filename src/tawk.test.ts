import { expect, it } from 'vitest'
import { tawkEmbedSrc, tawkSettingsSchema } from './tawk'
import { settingsData } from './server/data'

const configured = {
  enabled: true,
  propertyId: '0123456789abcdef01234567',
  widgetId: 'default',
}

it('keeps existing settings disabled without a migration', () => {
  const settings = settingsData({
    rateBps: 200,
    settlementDays: 7,
    minimumWithdrawal: 1000,
    firstOrderOnly: false,
    alipay: true,
    wechat: true,
    crypto: false,
    fiatProvider: 'xorpay',
  })
  expect(settings.tawk).toEqual({ enabled: false, propertyId: '', widgetId: '' })
  expect(tawkEmbedSrc(settings.tawk)).toBeUndefined()
  expect(tawkEmbedSrc(undefined)).toBeUndefined()
})

it('requires both IDs only when enabled and supports the default widget', () => {
  expect(tawkSettingsSchema.safeParse({ enabled: true }).success).toBe(false)
  expect(tawkSettingsSchema.safeParse({ ...configured, widgetId: '' }).success).toBe(false)
  expect(tawkSettingsSchema.safeParse({ ...configured, propertyId: '' }).success).toBe(false)
  expect(tawkEmbedSrc(configured)).toBe('https://embed.tawk.to/0123456789abcdef01234567/default')
  expect(
    tawkEmbedSrc({ ...configured, propertyId: ` ${configured.propertyId} `, widgetId: ' 1abc23 ' }),
  ).toBe('https://embed.tawk.to/0123456789abcdef01234567/1abc23')
  expect(tawkEmbedSrc({ ...configured, enabled: false })).toBeUndefined()
})

it('rejects URLs, scripts and path injection rather than accepting arbitrary embeds', () => {
  for (const field of ['propertyId', 'widgetId']) {
    for (const value of [
      'https://evil.example/widget',
      '../other',
      'default?redirect=evil',
      '<script>alert(1)</script>',
      'default#fragment',
      'a'.repeat(65),
    ]) {
      const input = { ...configured, [field]: value }
      expect(tawkSettingsSchema.safeParse(input).success).toBe(false)
      expect(tawkEmbedSrc(input)).toBeUndefined()
    }
  }
})
