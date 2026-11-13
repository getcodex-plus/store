import { defineConfig, devices } from '@playwright/test'
if (process.env.E2E_DATABASE_PREPARED !== 'true')
  throw new Error('Run bun run test:e2e to prepare an isolated Prisma database first')
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000'
const port = new URL(baseURL).port || '3000'
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      process.env.E2E_PRODUCTION === 'true'
        ? `bun run start --port ${port}`
        : `bun run dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
  },
})
