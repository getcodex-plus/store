'use client'

import { useEffect, useRef, useState } from 'react'
import Script from 'next/script'
import { usePathname } from 'next/navigation'
import { analyticsAllowed } from '../funnel-client'
import { analyticsPage, analyticsReferrer } from '../google-analytics'

declare global {
  interface Window {
    dataLayer?: IArguments[]
    gtag?: (command: string, ...args: unknown[]) => void
  }
}

export function GoogleAnalytics({ gaId, nonce }: { gaId: string; nonce?: string }) {
  const pathname = usePathname()
  const [enabled, setEnabled] = useState(false)
  const initialized = useRef(false)
  const previousPath = useRef<string | null>(null)
  const previousLocation = useRef('')

  useEffect(() => {
    if (!analyticsAllowed()) return
    // Suppress Strict Mode effect replays, but count a return to a previous page.
    // Query-only changes intentionally do not create additional page views.
    if (previousPath.current === pathname) return

    window.dataLayer ??= []
    window.gtag ??= function () {
      window.dataLayer!.push(arguments)
    }
    const page = {
      ...analyticsPage(pathname, window.location.origin),
      page_referrer: previousLocation.current || analyticsReferrer(document.referrer),
    }
    // Set sanitized defaults before configuration, including for GA's automatic
    // session/engagement events. Enhanced measurement must be OFF in the stream.
    window.gtag('set', page)
    if (!initialized.current) {
      window.gtag('js', new Date())
      window.gtag('config', gaId, {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      })
      initialized.current = true
    }
    window.gtag('event', 'page_view', { ...page, send_to: gaId })
    previousPath.current = pathname
    previousLocation.current = page.page_location
    setEnabled(true)
  }, [gaId, pathname])

  if (!enabled) return null
  return (
    <Script
      id="google-analytics"
      src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
      strategy="afterInteractive"
      nonce={nonce}
    />
  )
}
