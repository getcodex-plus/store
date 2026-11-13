import { db, transaction } from '../src/server/db'
import { migrateCredentialStorage } from '../src/server/credential-storage'

// Explicit maintenance operation; never invoked by deploy or seed.
try {
  await transaction(migrateCredentialStorage, { timeout: 600_000 })
  console.log('Credential storage verified and upgraded.')
} finally {
  await db.$disconnect()
}
