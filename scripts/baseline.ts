import { db } from '../src/server/db'
import { verifyDatabase } from '../src/server/database-catalog'
import { spawn } from 'node:child_process'

// No DDL is inferred here. The complete existing schema and data prerequisites
// must match before Prisma is allowed to record the baseline as already applied.
try {
  await verifyDatabase(db, true)
  const [state] = await db.$queryRaw<{ migrations: string | null }[]>`
    SELECT to_regclass(format('%I._prisma_migrations', current_schema()))::text AS migrations`
  const baseline = '00000000000000_baseline'
  if (state.migrations) {
    const applied = await db.$queryRaw<{ finished: boolean }[]>`
      SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS finished
      FROM _prisma_migrations WHERE migration_name=${baseline}`
    if (applied.some((row) => row.finished)) {
      console.log('Baseline already applied; database contract verified.')
      process.exitCode = 0
    } else {
      throw new Error('Existing migration history requires review before baselining')
    }
  } else {
    const child = spawn(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'resolve',
        '--applied',
        baseline,
        '--config',
        'prisma7.config.ts',
      ],
      { env: process.env, stdio: 'inherit' },
    )
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) throw new Error('Prisma could not record the baseline')
  }
} finally {
  await db.$disconnect()
}
