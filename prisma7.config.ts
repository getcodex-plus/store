import { defineConfig } from 'prisma/config'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('.env', import.meta.url))
if (existsSync(envFile)) loadEnvFile(envFile)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL },
})
