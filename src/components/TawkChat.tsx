'use client'

import { useEffect, useState } from 'react'
import Script from 'next/script'

declare global {
  interface Window {
    Tawk_API?: {
      customStyle?: {
        zIndex: number
        visibility: {
          desktop: { position: 'br'; xOffset: number; yOffset: number }
          mobile: { position: 'br'; xOffset: number; yOffset: number }
        }
      }
    }
    Tawk_LoadStart?: Date
  }
}

export function TawkChat({ src, nonce }: { src?: string; nonce?: string }) {
  // Configuration belongs to this document. Apply dashboard changes on a full
  // reload, rather than injecting a second widget into an ongoing conversation.
  const [initialSrc] = useState(src)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!initialSrc) return
    window.Tawk_API ??= {}
    window.Tawk_API.customStyle = {
      // Keep authentication dialogs and drawers (Ant Design: 1000+) usable.
      zIndex: 900,
      visibility: {
        desktop: { position: 'br', xOffset: 24, yOffset: 24 },
        mobile: { position: 'br', xOffset: 16, yOffset: 24 },
      },
    }
    window.Tawk_LoadStart ??= new Date()
    setReady(true)
  }, [initialSrc])

  if (!initialSrc || !ready) return null
  return (
    <Script
      id="tawk-chat"
      src={initialSrc}
      strategy="afterInteractive"
      nonce={nonce}
      crossOrigin="anonymous"
    />
  )
}
