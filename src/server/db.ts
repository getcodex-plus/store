import pg from 'pg'
import type { PoolClient } from 'pg'

const globalDB = globalThis as unknown as { getgptPool?: pg.Pool }
export const pool =
  globalDB.getgptPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
globalDB.getgptPool = pool

export function row<T>(input: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  ) as T
}
export async function rows<T>(
  sql: string,
  values: unknown[] = [],
  client: pg.Pool | PoolClient = pool,
): Promise<T[]> {
  return (await client.query(sql, values)).rows.map((r) => row<T>(r))
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
