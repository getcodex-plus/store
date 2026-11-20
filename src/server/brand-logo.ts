import { createHash } from 'node:crypto'
import { z } from 'zod'
import { maxBrandNameLength, maxLogoBytes, pngPrefix } from '../branding'
import { ApiError } from './config'

export const brandNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(maxBrandNameLength)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|%s/u.test(value))
export const brandLogoSchema = z
  .string()
  .max(pngPrefix.length + 4 * Math.ceil(maxLogoBytes / 3))
  .refine((value) => !value || value.startsWith(pngPrefix))

export async function normalizeBrandLogo(value: string) {
  if (!value) return ''
  try {
    if (!value.startsWith(pngPrefix)) throw new Error()
    const bytes = Buffer.from(value.slice(pngPrefix.length), 'base64')
    if (
      bytes.length > maxLogoBytes ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    )
      throw new Error()
    const { default: sharp } = await import('sharp')
    const image = sharp(bytes, { limitInputPixels: 1024 * 1024, failOn: 'warning' })
    const png = await image
      .resize(180, 180, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ palette: true })
      .toBuffer()
    return pngPrefix + png.toString('base64')
  } catch {
    throw new ApiError(400, 'Logo 必须是有效的 PNG 图片，最大 64 KB、最多 100 万像素')
  }
}

export function brandLogoUrl(logo: string) {
  return `/brand-logo?v=${createHash('sha256').update(logo).digest('hex').slice(0, 16)}`
}
