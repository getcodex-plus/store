import type { MetadataRoute } from 'next'
import { products } from '../server/services'
export const dynamic = 'force-dynamic'
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = process.env.APP_URL || 'http://localhost:3000'
  return ['', '/guide', ...(await products()).map((p) => `/plans/${p.id}`)].map((path) => ({
    url: `${origin}${path}`,
    changeFrequency: 'weekly',
    priority: path === '' ? 1 : 0.7,
  }))
}
