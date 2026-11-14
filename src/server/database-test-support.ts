import { db, createDatabase, databaseSchema, Prisma } from './db'
import { initializeDatabase } from './database-init'

function testTarget() {
  const url = new URL(process.env.DATABASE_URL!)
  if (!process.env.TEST_DATABASE_URL || !url.pathname.endsWith('_test'))
    throw new Error('Database tests require a dedicated _test database')
  const schema = databaseSchema(url.toString())
  if (!/^test_[a-z0-9_]+$/.test(schema))
    throw new Error('Database tests require an isolated test_ schema')
  return { url, schema }
}

export async function prepareTestDatabase() {
  const { url, schema } = testTarget()
  const target = url.toString()
  url.searchParams.set('schema', 'public')
  const admin = createDatabase(url.toString())
  try {
    await admin.$executeRaw(Prisma.sql`CREATE SCHEMA ${Prisma.raw(`"${schema}"`)}`)
    await initializeDatabase(target)
  } finally {
    await admin.$disconnect()
  }
}

export async function cleanupTestDatabase() {
  const { url, schema } = testTarget()
  await db.$disconnect()
  url.searchParams.set('schema', 'public')
  const admin = createDatabase(url.toString())
  try {
    await admin.$executeRaw(Prisma.sql`DROP SCHEMA IF EXISTS ${Prisma.raw(`"${schema}"`)} CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

// Independent SQL fixtures and assertions deliberately bypass model APIs: these
// integration tests verify database invariants as well as application behavior.
// All statements are parameterized Prisma.Sql values, never SQL from API inputs.
export async function testQuery<T = Record<string, any>>(
  statement: Prisma.Sql,
): Promise<{ rows: T[]; rowCount: number }> {
  if (/^\s*(SELECT|WITH)\b/i.test(statement.sql) || /\bRETURNING\b/i.test(statement.sql)) {
    const records = await db.$queryRaw<Record<string, unknown>[]>(statement)
    const rows = records.map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          key,
          typeof value === 'bigint'
            ? value.toString()
            : Prisma.Decimal.isDecimal(value)
              ? value.toFixed(6)
              : value,
        ]),
      ),
    ) as T[]
    return { rows, rowCount: rows.length }
  }
  return { rows: [], rowCount: await db.$executeRaw(statement) }
}
