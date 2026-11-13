import type { Metadata } from 'next'
import { GoogleAnalytics, GoogleTagManager } from '@next/third-parties/google'
import { AntdRegistry } from '@ant-design/nextjs-registry'
import { Providers } from '../components/Providers'
import { SiteHeader, SiteFooter } from '../components/Site'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL || 'http://localhost:3000'),
  title: { default: 'GetGPT · 你的 GPT 升级助手', template: '%s · GetGPT' },
  description: '为自己的 GPT 账号充值与升级。先确认账号与价格，再付款，随时查看订单进度。',
  icons: { icon: '/favicon.svg' },
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
