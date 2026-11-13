import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { db } from '../src/server/db'
import {
  databaseContract,
  verifyDatabase,
  verifyDataPrerequisites,
  type DatabaseContract,
} from '../src/server/database-catalog'

const supported = new Set([
  'auth_account.registrationRecord',
  'orders.fulfillment_status',
  'orders.redemption_version',
  'orders.submission_attempted',
  'quotes.flow_version',
  'quotes.preflight_expires_at',
  'auth_account.auth_account_registrationRecord_key',
  'auth_account.auth_one_opaque_account',
  'orders.orders_redemption_version_not_null',
  'orders.orders_submission_attempted_not_null',
  'quotes.quotes_flow_version_not_null',
])

try {
  const expected: DatabaseContract = JSON.parse(
    await readFile(new URL('../prisma/database-contract.json', import.meta.url), 'utf8'),
  )
  const actual = await databaseContract()
  for (const group of Object.keys(expected) as (keyof DatabaseContract)[]) {
    const entries = new Map(actual[group].map((item) => [item.key, item.definition]))
    for (const item of expected[group]) {
      const current = entries.get(item.key)
      if (current === item.definition) continue
      if (current === undefined && supported.has(item.key)) continue
      if (group === 'columns' && item.key === 'orders.request_hash' && current === 'text|true|')
        continue
      if (
        group === 'constraints' &&
        item.key === 'exchange_rates.exchange_rates_id_check' &&
        [
          "CHECK ((id = ANY (ARRAY['USD_CNY'::text, 'USDT_CNY'::text])))",
          "CHECK ((id = 'USD_CNY'::text))",
        ].includes(current ?? '')
      )
        continue
      throw new Error(
        `Unrecognized legacy schema: ${group} ${item.key}; upgrade the previous release first`,
      )
    }
  }
  // Check data prerequisites before running DDL; the bridge never decrypts or
  // rewrites inventory, password records, configuration, prices or financial data.
  await verifyDataPrerequisites()
  const child = spawn(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'db',
      'execute',
      '--file',
      'prisma/legacy/upgrade-to-baseline.sql',
      '--config',
      'prisma7.config.ts',
    ],
    { env: process.env, stdio: 'inherit' },
  )
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error('Legacy upgrade failed')
  await verifyDatabase()
  console.log('Legacy compatibility upgrade completed; database verified for db:baseline.')
} finally {
  await db.$disconnect()
}
