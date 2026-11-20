import { pngPrefix } from '../../branding'
import { readSiteSettings } from '../../server/site-settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  const logo = (await readSiteSettings())?.brandLogo
  if (!logo) return new Response(null, { status: 404 })
  return new Response(Buffer.from(logo.slice(pngPrefix.length), 'base64'), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
  })
}
