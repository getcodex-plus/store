import { defineConfig } from 'vitest/config'
if (process.env.CI && !process.env.TEST_DATABASE_URL)
  throw new Error('CI must configure TEST_DATABASE_URL; database tests must not be skipped')
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } })
