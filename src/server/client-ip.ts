import { getIP } from '@better-auth/core/utils/ip'

// Share both the header policy and parser with authentication.
export const clientIPOptions = { ipAddressHeaders: ['x-forwarded-for'] }

export function clientIP(
  headers: Headers,
  options: { ipv6Subnet?: number } = {},
): string | undefined {
  return (
    getIP(headers, { advanced: { ipAddress: { ...clientIPOptions, ...options } } }) ?? undefined
  )
}
