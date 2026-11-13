import type { Metadata } from 'next'

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

export function pageMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      locale: 'zh_CN',
      siteName: 'GetCodex Plus',
      title: `${title} · GetCodex Plus`,
      description,
      url: path,
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'GetCodex Plus 充值与升级' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · GetCodex Plus`,
      description,
      images: ['/opengraph-image'],
    },
  }
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
