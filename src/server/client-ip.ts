import { findInvalidTrustedProxies, getIP } from '@better-auth/core/utils/ip'

export function parseTrustedProxies(raw = process.env.TRUSTED_PROXIES): string[] | undefined {
  const entries = (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!entries.length) return undefined
  const invalid = findInvalidTrustedProxies(entries)
  if (invalid.length) throw new Error(`Invalid TRUSTED_PROXIES entry: ${invalid.join(', ')}`)
  return entries
}

// Share both the header policy and parser with authentication.
export const clientIPOptions: {
  ipAddressHeaders: string[]
  readonly trustedProxies?: string[]
} = {
  ipAddressHeaders: ['x-forwarded-for'],
  get trustedProxies() {
    return parseTrustedProxies()
  },
}

export function clientIP(
  headers: Headers,
  options: { ipv6Subnet?: number } = {},
): string | undefined {
  return (
    getIP(headers, {
      advanced: {
        ipAddress: {
          ipAddressHeaders: clientIPOptions.ipAddressHeaders,
          trustedProxies: clientIPOptions.trustedProxies,
          ...options,
        },
      },
    }) ?? undefined
  )
}
