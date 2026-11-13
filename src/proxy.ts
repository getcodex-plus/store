import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString('base64')
  const development = process.env.NODE_ENV === 'development'
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    // Ant Design uses inline styles. Scripts still require a per-response nonce.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://challenges.cloudflare.com${development ? ' ws: wss:' : ''}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    'frame-src https://challenges.cloudflare.com',
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
