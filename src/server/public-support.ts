import { cache } from 'react'
import { db } from './db'
import { settingsData } from './data'

// Request-local memoization: layout and support blocks share one read.
// Only these public fields may cross the Server/Client Component boundary.
export const publicSupport = cache(async () => {
  const record = await db.setting.findUnique({ where: { id: 1 } })
  if (!record) return { supportEmail: '', sessionGuideUrl: undefined }
  const settings = settingsData(record.body)
  return {
    supportEmail: settings.supportEmail,
    sessionGuideUrl: settings.sessionGuideUrl,
  }
})
