import { defineConfig } from 'vitest/config'
if (process.env.CI && !process.env.TEST_DATABASE_URL)
  throw new Error(
    'CI must configure TEST_DATABASE_URL; skipped database tests are not a migration check',
  )
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } })
