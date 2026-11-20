export const defaultBrandName = 'GetCodex Plus'
export const maxBrandNameLength = 40
export const maxLogoBytes = 64 * 1024
export const pngPrefix = 'data:image/png;base64,'

export interface SiteBrand {
  name: string
  logoUrl?: string
}
