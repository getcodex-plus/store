import type { MetadataRoute } from 'next'
export default function robots(): MetadataRoute.Robots {
  const origin = process.env.APP_URL || 'http://localhost:3000'
  return {
    rules:
      process.env.APP_MODE === 'live'
        ? {
            userAgent: '*',
            allow: '/',
            disallow: [
              '/api/',
              '/admin',
              '/account',
              '/wallet',
              '/checkout',
              '/orders/',
              '/referral',
              '/security',
            ],
          }
        : { userAgent: '*', disallow: '/' },
    sitemap: `${origin}/sitemap.xml`,
  }
}
