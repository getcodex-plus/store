import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { AntdRegistry } from '@ant-design/nextjs-registry'
import { Providers } from '../components/Providers'
import { SiteHeader, SiteFooter } from '../components/Site'
import './globals.css'
import { siteOrigin } from '../seo'
import { publicSupport, siteBrand } from '../server/site-settings'
import { GoogleAnalytics } from '../components/GoogleAnalytics'
import { googleAnalyticsId } from '../google-analytics'
import { TawkChat } from '../components/TawkChat'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const { name, logoUrl } = await siteBrand()
  return {
    metadataBase: new URL(siteOrigin()),
    title: { default: `ChatGPT 充值 · ${name}`, template: `%s · ${name}` },
    description: '为自己的 GPT 账号充值。先确认账号与价格，再付款，随时查看订单进度。',
    applicationName: name,
    icons: logoUrl
      ? { icon: logoUrl, apple: logoUrl }
      : {
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
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Dynamic rendering is required: a cached document must not reuse a CSP nonce.
  const nonce = (await headers()).get('x-nonce') || undefined
  const [{ supportEmail, tawkSrc }, brand] = await Promise.all([publicSupport(), siteBrand()])
  const gaId = googleAnalyticsId(process.env.NEXT_PUBLIC_GA_ID)

  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>
        <AntdRegistry>
          <Providers nonce={nonce} brand={brand}>
            <SiteHeader />
            {children}
            <SiteFooter supportEmail={supportEmail} />
          </Providers>
        </AntdRegistry>
        {gaId && <GoogleAnalytics gaId={gaId} brandName={brand.name} nonce={nonce} />}
        <TawkChat src={tawkSrc} nonce={nonce} />
      </body>
    </html>
  )
}
