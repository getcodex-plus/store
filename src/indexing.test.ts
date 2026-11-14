import { afterEach, expect, it, vi } from 'vitest'
import robots from './app/robots'
import sitemap from './app/sitemap'
import { products } from './server/services'

vi.mock('./server/services', () => ({ products: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it('keeps demo sites out of search without querying the catalog', async () => {
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('APP_URL', 'http://localhost:3000')
  expect(robots().rules).toEqual({ userAgent: '*', disallow: '/' })
  expect(await sitemap()).toEqual([])
  expect(products).not.toHaveBeenCalled()
})

it('publishes only discovery pages and available catalog URLs on the production origin', async () => {
  vi.stubEnv('APP_MODE', 'live')
  vi.stubEnv('APP_URL', 'https://getcodex.plus')
  vi.mocked(products).mockResolvedValue([{ id: 'plus' }, { id: 'upgrade-plus' }] as Awaited<
    ReturnType<typeof products>
  >)
  const policy = robots()
  expect(policy.rules).toEqual({ userAgent: '*', allow: '/', disallow: ['/api/'] })
  expect(policy.sitemap).toBe('https://getcodex.plus/sitemap.xml')
  const urls = (await sitemap()).map(({ url }) => url)
  expect(urls).toEqual([
    'https://getcodex.plus',
    'https://getcodex.plus/guide',
    'https://getcodex.plus/compare',
    'https://getcodex.plus/upgrade',
    'https://getcodex.plus/help/payment',
    'https://getcodex.plus/terms',
    'https://getcodex.plus/privacy',
    'https://getcodex.plus/plans/plus',
    'https://getcodex.plus/plans/upgrade-plus',
  ])
})
