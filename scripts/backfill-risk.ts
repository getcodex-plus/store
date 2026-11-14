import { db } from '../src/server/db'
import { decrypt } from '../src/server/crypto'
import { payoutFingerprint } from '../src/server/risk'

// Run with the same ENCRYPTION_KEY as web/worker after db:migrate.
// Resumable and safe alongside new withdrawals; no plaintext account is logged.
export async function backfillRiskIdentities() {
  let count = 0
  for (;;) {
    const rows = await db.withdrawal.findMany({
      where: { payoutFingerprint: null },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, userId: true, method: true, network: true, account: true },
    })
    if (!rows.length) return count
    for (const row of rows) {
      const fingerprint = payoutFingerprint(
        row.method,
        row.network,
        decrypt(row.account, `withdrawal:${row.userId}`),
      )
      const updated = await db.withdrawal.updateMany({
        where: { id: row.id, payoutFingerprint: null },
        data: { payoutFingerprint: fingerprint },
      })
      count += updated.count
    }
  }
}

if (import.meta.main) {
  try {
    console.log(`Backfilled ${await backfillRiskIdentities()} withdrawal risk identities.`)
  } catch {
    console.error('Risk backfill failed. Check database access and the existing encryption key.')
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
