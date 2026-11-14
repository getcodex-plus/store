import { initializeDatabase } from '../src/server/database-init'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
await initializeDatabase(process.env.DATABASE_URL)
console.log('Database initialized.')
