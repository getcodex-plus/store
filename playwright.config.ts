import { defineConfig, devices } from '@playwright/test'
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
    reuseExistingServer: !process.env.CI && !process.env.E2E_BASE_URL,
    timeout: 120000,
  },
})
