import { db } from './db'
import { demo, validateRuntime } from './config'
import { refreshPendingExchangeRates } from './exchange-rates'
import { tick } from './worker-tasks'
import { syncStockPurchase } from './procurement'

validateRuntime()
let stopping = false
process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})
console.log('GetCodex Plus worker running; mode:', demo ? 'demo' : 'live')
const exchangeLoop = (async () => {
  while (!stopping) {
    try {
      await refreshPendingExchangeRates()
    } catch {
      console.error('Exchange rate refresh failed; retrying')
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
})()
const procurementLoop = (async () => {
  while (!stopping && !demo) {
    try {
      if (await syncStockPurchase()) continue
    } catch {
      console.error('Stock procurement sync failed; retrying')
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
})()
while (!stopping) {
  try {
    const worked = await tick()
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 2000))
  } catch {
    console.error('Worker iteration failed; retrying')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}
await Promise.all([exchangeLoop, procurementLoop])
await db.$disconnect()
