'use client'
import { useEffect } from 'react'
import { useSite } from './Providers'
import { trackFunnel } from '../funnel-client'
import type { ClientEvent } from '../funnel'

export function FunnelView({ event, productId }: { event: ClientEvent; productId: string }) {
  const { data } = useSite()
  useEffect(() => {
    // Bootstrap establishes the existing HttpOnly browser cookie before events.
    if (data) trackFunnel(event, productId)
  }, [!!data, event, productId])
  return null
}
