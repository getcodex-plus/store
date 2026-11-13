'use client'
import { api } from './lib'
import { classifySource, sourceSchema, type ClientEvent, type FunnelSource } from './funnel'

export function analyticsAllowed() {
  return (
    typeof window !== 'undefined' &&
    navigator.doNotTrack !== '1' &&
    !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
  )
}
export function attributionSource(): FunnelSource {
  if (!analyticsAllowed()) return 'direct'
  const source = classifySource(window.location.search, document.referrer, window.location.origin)
  try {
    const stored = sourceSchema.safeParse(sessionStorage.getItem('getgpt_source'))
    if (stored.success) return stored.data
    sessionStorage.setItem('getgpt_source', source)
  } catch {
    /* Storage may be unavailable; analytics never blocks checkout. */
  }
  return source
}
export function trackFunnel(event: ClientEvent, productId: string) {
  if (!analyticsAllowed()) return
  void api('/events', { event, productId, source: attributionSource() }).catch(() => {})
}
