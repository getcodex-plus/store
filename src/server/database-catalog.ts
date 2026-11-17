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
  'coupon_redemptions',
  'coupons',
  'demo_mailbox',
  'email_outbox',
  'exchange_rates',
  'funnel_events',
  'integrations',
  'inventory',
  'inventory_batches',
  'inventory_replacements',
  'jobs',
  'orders',
  'payment_events',
  'products',
  'quotes',
  'rate_limits',
  'roles',
  'risk_events',
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

export async function verifyDatabase(client: DbClient = db) {
  const expected: DatabaseContract = JSON.parse(
    await readFile(new URL('../../prisma/database-contract.json', import.meta.url), 'utf8'),
  )
  const actual = await databaseContract(client)
  const problems: string[] = []
  for (const category of Object.keys(expected) as (keyof DatabaseContract)[]) {
    const entries = new Map(actual[category].map((e) => [e.key, e.definition]))
    for (const item of expected[category]) {
      if (entries.get(item.key) !== item.definition) problems.push(`${category}: ${item.key}`)
      entries.delete(item.key)
    }
    for (const key of entries.keys()) problems.push(`Unexpected ${category}: ${key}`)
  }
  if (problems.length)
    throw new Error(`Database structure does not match the schema:\n${problems.join('\n')}`)
  return actual
}
