import type { MetadataRoute } from 'next'
import { siteOrigin } from '../seo'
export const dynamic = 'force-dynamic'
export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin()
  return {
    rules:
      process.env.APP_MODE === 'live'
        ? {
            userAgent: '*',
            allow: '/',
            // Let crawlers read noindex on application pages. APIs remain blocked;
            // authentication, rather than robots.txt, protects private data.
            disallow: ['/api/'],
          }
        : { userAgent: '*', disallow: '/' },
    sitemap: `${origin}/sitemap.xml`,
  }
}
