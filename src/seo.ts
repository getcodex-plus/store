import type { Metadata } from 'next'
import { siteBrand } from './server/site-settings'

export function siteOrigin() {
  const raw = process.env.APP_URL || 'http://localhost:3000'
  const url = new URL(raw)
  if (
    process.env.APP_MODE === 'live' &&
    (url.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Error('正式环境必须配置有效的 HTTPS APP_URL')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('APP_URL 只能包含站点协议、域名和端口')
  return url.origin
}

export async function pageMetadata(
  title: string,
  description: string,
  path: string,
): Promise<Metadata> {
  const { name } = await siteBrand()
  const brandedTitle = `${title} · ${name}`
  return {
    title: { absolute: brandedTitle },
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      locale: 'zh_CN',
      siteName: name,
      title: brandedTitle,
      description,
      url: path,
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: `${name} 充值` }],
    },
    twitter: {
      card: 'summary_large_image',
      title: brandedTitle,
      description,
      images: ['/opengraph-image'],
    },
  }
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
