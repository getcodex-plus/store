import type { MetadataRoute } from 'next'
import { products } from '../server/services'
import { siteOrigin } from '../seo'
export const dynamic = 'force-dynamic'
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin()
  if (process.env.APP_MODE !== 'live') return []
  return [
    '',
    '/guide',
    '/compare',
    '/help/payment',
    '/terms',
    '/privacy',
    ...(await products()).map((p) => `/plans/${p.id}`),
  ].map((path) => ({
    url: `${origin}${path}`,
  }))
}
