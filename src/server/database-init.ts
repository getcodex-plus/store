import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { databaseSchema } from './db'

export async function initializeDatabase(connectionString: string) {
  const schema = databaseSchema(connectionString)
  const url = new URL(connectionString)
  url.searchParams.delete('schema')
  const pool = new Pool({ connectionString: url.toString(), max: 1 })
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present,
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1)
          OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=$1) AS occupied`,
        [schema],
      )
      if (!rows[0].present) throw new Error('Database initialization requires an existing schema')
      if (rows[0].occupied) throw new Error('Database initialization requires an empty schema')
      await client.query("SELECT set_config('search_path', $1, true)", [schema])
      const sql = await readFile(new URL('../../prisma/init.sql', import.meta.url), 'utf8')
      await client.query(sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}
