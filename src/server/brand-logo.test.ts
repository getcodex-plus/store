import { expect, it } from 'vitest'
import sharp from 'sharp'
import { defaultBrandName, maxLogoBytes, pngPrefix } from '../branding'
import { brandLogoSchema, brandLogoUrl, brandNameSchema, normalizeBrandLogo } from './brand-logo'
import { settingsData } from './data'

it('keeps the existing brand for deployments without branding settings', () => {
  expect(
    settingsData({
      rateBps: 0,
      settlementDays: 0,
      firstOrderOnly: false,
      alipay: false,
      wechat: false,
      crypto: false,
      fiatProvider: 'xorpay',
    }),
  ).toMatchObject({ brandName: defaultBrandName, brandLogo: '' })
  expect(brandNameSchema.parse('  北辰商店  ')).toBe('北辰商店')
  for (const name of ['', ' ', 'a'.repeat(41), 'a\r\nb', String.fromCharCode(0x202e), '%s'])
    expect(brandNameSchema.safeParse(name).success).toBe(false)
})

it('normalizes uploaded PNGs to a bounded, same-origin brand icon', async () => {
  const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const normalized = await normalizeBrandLogo(pngPrefix + image.toString('base64'))
  const bytes = Buffer.from(normalized.slice(pngPrefix.length), 'base64')
  expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 180, height: 180 })
  expect(brandLogoUrl(normalized)).toMatch(/^\/brand-logo\?v=[0-9a-f]{16}$/)
  expect(await normalizeBrandLogo('')).toBe('')
})

it('rejects remote URLs, invalid images, oversized files and excessive decoded dimensions', async () => {
  const huge = await sharp({
    create: { width: 1500, height: 1500, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  for (const logo of [
    'https://example.com/image.png',
    'data:image/svg+xml,<svg/>',
    pngPrefix + 'abcd',
    pngPrefix + huge.toString('base64'),
  ])
    await expect(normalizeBrandLogo(logo)).rejects.toMatchObject({ status: 400 })
  expect(
    brandLogoSchema.safeParse(pngPrefix + Buffer.alloc(maxLogoBytes + 4).toString('base64'))
      .success,
  ).toBe(false)
})
