import type { Metadata } from 'next'
import { GoogleAnalytics, GoogleTagManager } from '@next/third-parties/google'
import { AntdRegistry } from '@ant-design/nextjs-registry'
import { Providers } from '../components/Providers'
import { SiteHeader, SiteFooter } from '../components/Site'
import './globals.css'
import { siteOrigin } from '../seo'

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: { default: 'ChatGPT 充值与升级 · GetCodex Plus', template: '%s · GetCodex Plus' },
  description: '为自己的 GPT 账号充值与升级。先确认账号与价格，再付款，随时查看订单进度。',
  applicationName: 'GetCodex Plus',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    apple: { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION,
    other: process.env.BING_SITE_VERIFICATION
      ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION }
      : undefined,
  },
  robots:
    process.env.APP_MODE === 'live'
      ? { index: true, follow: true }
      : { index: false, follow: false },
}
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const gaId = process.env.NEXT_PUBLIC_GA_ID?.trim()
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID?.trim()
  const analyticsEnabled = gaId && /^G-[A-Z0-9]+$/.test(gaId)
  const tagManagerEnabled = gtmId && /^GTM-[A-Z0-9]+$/.test(gtmId)

  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>
        <AntdRegistry>
          <Providers>
            <SiteHeader />
            {children}
            <SiteFooter />
          </Providers>
        </AntdRegistry>
        {tagManagerEnabled ? (
          <GoogleTagManager gtmId={gtmId} />
        ) : (
          analyticsEnabled && <GoogleAnalytics gaId={gaId} />
        )}
      </body>
    </html>
  )
}
