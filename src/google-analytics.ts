import { defaultBrandName } from './branding'

// Shared by the server layout and CSP: an empty or invalid ID disables GA.
export function googleAnalyticsId(value: string | undefined) {
  const id = value?.trim()
  return id && /^G-[A-Z0-9]+$/.test(id) ? id : undefined
}

const pages: Record<string, string> = {
  '/': '首页',
  '/compare': '套餐对比',
  '/guide': '购买指南',
  '/help/payment': '支付帮助',
  '/checkout': '结算',
  '/account': '账户',
  '/wallet': '钱包',
  '/referral': '邀请',
  '/security': '账户安全',
  '/admin': '管理后台',
  '/privacy': '隐私说明',
  '/terms': '服务条款',
}

export function analyticsPage(pathname: string, origin: string, brandName = defaultBrandName) {
  // Never forward arbitrary path segments, order IDs, query strings, hashes,
  // document titles, or form values. Unknown routes share a fixed fallback.
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/'
  const route = Object.hasOwn(pages, path)
    ? path
    : /^\/plans\/[^/]+$/.test(path)
      ? '/plans/detail'
      : /^\/orders\/[^/]+$/.test(path)
        ? '/orders/detail'
        : '/not-found'
  const title =
    pages[route] ??
    (route === '/plans/detail'
      ? '套餐详情'
      : route === '/orders/detail'
        ? '订单详情'
        : '页面未找到')
  return { page_location: `${origin}${route}`, page_title: `${title} · ${brandName}` }
}

export function analyticsReferrer(referrer: string) {
  try {
    const url = new URL(referrer)
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}/` : ''
  } catch {
    return ''
  }
}
