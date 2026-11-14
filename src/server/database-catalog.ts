// Operational schema verification, separate from runtime business queries.
import { readFile } from 'node:fs/promises'
import { db, Prisma, type DbClient } from './db'

export const managedTables = [
  'audit',
  'auth_account',
  'auth_passkey',
  'auth_rate_limit',
  'auth_session',
  'auth_verification',
  'commissions',
  'demo_mailbox',
  'email_outbox',
  'exchange_rates',
  'funnel_events',
  'integrations',
  'inventory',
  'jobs',
  'orders',
  'payment_events',
  'products',
  'quotes',
  'rate_limits',
  'roles',
  'settings',
  'twoFactor',
  'user_roles',
  'users',
  'wallet_ledger',
  'wallets',
  'withdrawals',
] as const
const functions = [
  'auth_last_passkey_removed',
  'auth_passkey_enable_mfa',
  'auth_passkey_owner_lock',
  'auth_passkey_requires_mfa',
  'enqueue_order_email',
  'record_funnel_order',
]
type Entry = { key: string; definition: string }
export type DatabaseContract = Record<
  'columns' | 'constraints' | 'indexes' | 'triggers' | 'functions',
  Entry[]
>

export async function databaseContract(client: DbClient = db): Promise<DatabaseContract> {
  const [{ schema }] = await client.$queryRaw<
    { schema: string }[]
  >`SELECT current_schema() AS schema`
  const tables = Prisma.join(managedTables)
  const [columns, constraints, indexes, triggers, definitions] = await Promise.all([
    client.$queryRaw<Entry[]>(Prisma.sql`SELECT c.relname || '.' || a.attname AS key,
      format_type(a.atttypid,a.atttypmod) || '|' || a.attnotnull::text || '|' ||
        COALESCE(pg_get_expr(d.adbin,d.adrelid),'') AS definition
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=current_schema() AND c.relname IN (${tables}) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY key`),
    client.$queryRaw<
      Entry[]
    >(Prisma.sql`SELECT c.relname || '.' || k.conname AS key, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname IN (${tables}) ORDER BY key`),
    client.$queryRaw<
      Entry[]
    >(Prisma.sql`SELECT tablename || '.' || indexname AS key, indexdef AS definition FROM pg_indexes
      WHERE schemaname=current_schema() AND tablename IN (${tables}) ORDER BY key`),
    client.$queryRaw<
      Entry[]
    >(Prisma.sql`SELECT c.relname || '.' || t.tgname AS key, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname IN (${tables}) AND NOT t.tgisinternal ORDER BY key`),
    client.$queryRaw<
      Entry[]
    >(Prisma.sql`SELECT p.proname AS key, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname IN (${Prisma.join(functions)}) ORDER BY key`),
  ])
  const normalize = (entries: Entry[]) =>
    entries.map((e) => ({
      key: e.key,
      definition: e.definition.replaceAll(`"${schema}".`, '').replaceAll(`${schema}.`, '').trim(),
    }))
  return {
    columns: normalize(columns),
    constraints: normalize(constraints),
    indexes: normalize(indexes),
    triggers: normalize(triggers),
    functions: normalize(definitions),
  }
}

export async function verifyDatabase(client: DbClient = db, baselineOnly = false) {
  const expected: DatabaseContract = JSON.parse(
    await readFile(new URL('../../prisma/database-contract.json', import.meta.url), 'utf8'),
  )
  const actual = await databaseContract(client)
  const problems: string[] = []
  // Keep the historical contract intact for legacy adoption. Current installations
  // must have applied the migration removing these columns and their constraints.
  const removedColumns = ['products', 'quotes', 'orders'].map((table) => `${table}.service_terms`)
  const removedConstraints = ['products', 'quotes', 'orders'].map(
    (table) => `${table}.${table}_service_terms_not_null`,
  )
  for (const category of Object.keys(expected) as (keyof DatabaseContract)[]) {
    const entries = new Map(actual[category].map((e) => [e.key, e.definition]))
    for (const item of expected[category]) {
      if (
        !baselineOnly &&
        ((category === 'columns' && removedColumns.includes(item.key)) ||
          (category === 'constraints' && removedConstraints.includes(item.key)))
      ) {
        if (entries.has(item.key)) problems.push(`Removed ${category} still present: ${item.key}`)
        continue
      }
      if (entries.get(item.key) !== item.definition) problems.push(`${category}: ${item.key}`)
    }
  }
  if (problems.length)
    throw new Error(`Database is not at the required baseline:\n${problems.join('\n')}`)
  await verifyDataPrerequisites(client)
  if (!baselineOnly) {
    // Additive migrations are checked separately so db:baseline does not require
    // them in advance.
    await client.riskEvent.findFirst()
    await client.inventory.findFirst({ select: { enabled: true, batchId: true, createdAt: true } })
    await client.inventoryBatch.findFirst()
    await client.withdrawal.findFirst({ select: { payoutFingerprint: true } })
    const indexes = await client.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
      AND indexname IN ('risk_events_created','risk_events_reference','withdrawals_payout_identity')`
    if (indexes.length !== 3) throw new Error('ZEN risk migration is incomplete')
    await client.order.findFirst({
      select: {
        refundDestination: true,
        refundStatus: true,
        refundAutomatic: true,
        refundNote: true,
        refundActor: true,
        refundRequestedAt: true,
        refundCompletedAt: true,
        refundResolutionNote: true,
        refundResolvedBy: true,
      },
    })
    const refundConstraints = actual.constraints.filter((entry) =>
      [
        'orders.orders_refund_destination_check',
        'orders.orders_refund_status_check',
        'orders.orders_refund_record_check',
      ].includes(entry.key),
    )
    if (refundConstraints.length !== 3) throw new Error('Order refund migration is incomplete')
  }
  return actual
}

export async function verifyDataPrerequisites(client: DbClient = db) {
  if (
    (await client.inventory.count({ where: { NOT: { code: { startsWith: 'v2:' } } } })) ||
    (await client.quote.count({
      where: { preflightToken: { not: null }, NOT: { preflightToken: { startsWith: 'v2:' } } },
    }))
  )
    throw new Error('Legacy credentials require the pre-Prisma upgrade before baselining')
  if (
    (await client.twoFactor.count({ where: { backupCodes: { not: '' } } })) ||
    (await client.user.count({
      where: {
        passkeys: { some: {} },
        OR: [{ twoFactorEnabled: false }, { twoFactorEnabled: null }],
      },
    }))
  )
    throw new Error('Authentication invariants require the pre-Prisma upgrade before baselining')
}
