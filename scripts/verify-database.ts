import { db } from '../src/server/db'
import { verifyDatabase } from '../src/server/database-catalog'

try {
  const contract = await verifyDatabase()
  console.log(
    'Database verified:',
    Object.fromEntries(Object.entries(contract).map(([key, entries]) => [key, entries.length])),
  )
} finally {
  await db.$disconnect()
}
