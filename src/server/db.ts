import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Prisma } from '../generated/prisma/client'

export { Prisma }
export type DbClient = Prisma.TransactionClient

export function databaseSchema(connectionString: string): string {
  const schema = new URL(connectionString).searchParams.get('schema') ?? 'public'
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema')
  return schema
}

// Shared by Next.js, the worker, scripts and isolated database tests.
export function createDatabase(connectionString: string) {
  const schema = databaseSchema(connectionString)
  const url = new URL(connectionString)
  url.searchParams.delete('schema')
  // Model queries, raw queries and PostgreSQL functions must use the same schema.
  // adapter-pg normalizes timestamps to UTC, so require UTC on every connection.
  // Merely changing Node's TZ would leave database-generated expiry values wrong.
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options') ?? ''} -csearch_path=${schema} -ctimezone=UTC`.trim(),
  )
  const adapter = new PrismaPg(
    {
      connectionString: url.toString(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
    { schema },
  )
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 10_000, timeout: 10_000 },
  })
}

const connectionString = process.env.DATABASE_URL ?? 'postgresql://localhost/getgpt'
const cache = globalThis as unknown as {
  getcodexDatabase?: { url: string; client: PrismaClient }
}
export const db =
  cache.getcodexDatabase?.url === connectionString
    ? cache.getcodexDatabase.client
    : createDatabase(connectionString)
cache.getcodexDatabase = { url: connectionString, client: db }

export function transaction<T>(
  fn: (client: DbClient) => Promise<T>,
  options?: {
    maxWait?: number
    timeout?: number
    isolationLevel?: Prisma.TransactionIsolationLevel
  },
) {
  return db.$transaction(fn, options)
}

// AICDK can perform three consecutive calls, each bounded to 30 seconds.
// Keep this budget local instead of extending all database transactions.
export const upstreamTransaction = { maxWait: 10_000, timeout: 100_000 } as const
// A Plus checkout can preview/preflight a discount card, then do the same for
// a normal card after a definitive rejection: four calls of at most 30 seconds.
export const checkoutTransaction = { maxWait: 10_000, timeout: 130_000 } as const

export function uniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || (error.code === 'P2010' && error.meta?.code === '23505'))
  )
}
