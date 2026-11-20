import { cache } from 'react'
import { db } from './db'
import { settingsData } from './data'
import { tawkEmbedSrc } from '../tawk'
import { defaultBrandName, type SiteBrand } from '../branding'
import { brandLogoUrl } from './brand-logo'

export const readSiteSettings = cache(async () => {
  const record = await db.setting.findUnique({ where: { id: 1 } })
  return record ? settingsData(record.body) : undefined
})

export const siteBrand = cache(async (): Promise<SiteBrand> => {
  const settings = await readSiteSettings()
  return {
    name: settings?.brandName || defaultBrandName,
    logoUrl: settings?.brandLogo ? brandLogoUrl(settings.brandLogo) : undefined,
  }
})

export const publicSupport = cache(async () => {
  const settings = await readSiteSettings()
  return {
    supportEmail: settings?.supportEmail ?? '',
    sessionGuideUrl: settings?.sessionGuideUrl,
    tawkSrc: tawkEmbedSrc(settings?.tawk),
    // Same row as the rest of the support settings: no extra query. Drives the
    // crypto section on /help/payment so deployments without it stay silent.
    cryptoEnabled: settings?.crypto === true,
  }
})
