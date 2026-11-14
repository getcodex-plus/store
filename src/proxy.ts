import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { googleAnalyticsId } from './google-analytics'

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString('base64')
  const development = process.env.NODE_ENV === 'development'
  const analytics = Boolean(googleAnalyticsId(process.env.NEXT_PUBLIC_GA_ID))
  const analyticsConnections = analytics
    ? ' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com'
    : ''
  const policy = [
    "default-src 'self'",
    // OPAQUE requires WebAssembly compilation; JavaScript eval remains blocked in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://*.tawk.to${analytics ? ' https://www.googletagmanager.com' : ''}${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    // Ant Design uses inline styles. Scripts still require a per-response nonce.
    "style-src 'self' 'unsafe-inline' https://*.tawk.to",
    `connect-src 'self' https://challenges.cloudflare.com https://*.tawk.to wss://*.tawk.to https://*.tawk.link${analyticsConnections}${development ? ' ws: wss:' : ''}`,
    `img-src 'self' data: blob: https://www.gravatar.com https://*.tawk.to https://*.tawk.link${analytics ? ' https://*.google-analytics.com https://www.googletagmanager.com' : ''}`,
    "font-src 'self' https://*.tawk.to",
    "frame-src 'self' https://challenges.cloudflare.com https://*.tawk.to",
    "media-src 'self' https://*.tawk.to https://*.tawk.link",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!development && process.env.APP_MODE === 'live' ? ['upgrade-insecure-requests'] : []),
  ].join('; ')
  const headers = new Headers(request.headers)
  // Never trust a caller-supplied nonce/CSP. Next uses this CSP to nonce its runtime.
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', policy)
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|favicon.svg|apple-touch-icon.png|robots.txt|sitemap.xml|opengraph-image).*)',
  ],
}
