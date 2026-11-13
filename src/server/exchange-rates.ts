import { db } from './db'
import { databaseNow, claimExchangeRate } from './database-sql'
import { id } from './crypto'
import { ApiError } from './config'
import type { AdminData } from '../types'

export const exchangeSources = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
] as const
export const usdtExchangeSources = [
  'https://latest.currency-api.pages.dev/v1/currencies/usdt.json',
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usdt.json',
] as const
type ExchangeCurrency = string
export function supportedCurrency(currency: string) {
  return currency === 'USDT' || Intl.supportedValuesOf('currency').includes(currency)
}
function requireCurrency(currency: string) {
  if (!supportedCurrency(currency)) throw new ApiError(503, '暂不支持此报价币种，请联系支持')
}
export function sourcesForCurrency(currency: string) {
  requireCurrency(currency)
  if (currency === 'USDT') return usdtExchangeSources
  return exchangeSources.map((url) => url.replace('/usd.json', `/${currency.toLowerCase()}.json`))
}
export interface ExchangeRate {
  rateE8: number
  sourceDate: string
  fetchedAt: string
  expiresAt: string
  source?: string
}
export function parseExchangeRate(
  input: unknown,
  now = Date.now(),
  currency: ExchangeCurrency = 'USD',
): ExchangeRate {
  requireCurrency(currency)
  const data = input as ({ date?: string } & Record<string, { cny?: number }>) | null
  const date = data?.date
  const rate = data?.[currency.toLowerCase()]?.cny
  const sourceTime =
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? Date.parse(`${date}T00:00:00Z`)
      : NaN
  if (
    !Number.isFinite(sourceTime) ||
    new Date(sourceTime).toISOString().slice(0, 10) !== date ||
    sourceTime > now ||
    sourceTime + 72 * 3600000 <= now ||
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 100
  )
    throw new Error('INVALID_EXCHANGE_RATE')
  // Preserve up to eight decimal places, rounding upward only beyond this precision.
  const [whole, decimals] = rate.toFixed(12).split('.')
  const rateE8 = Number(
    BigInt(whole) * 100000000n +
      BigInt(decimals.slice(0, 8)) +
      (Number(decimals.slice(8)) > 0 ? 1n : 0n),
  )
  if (!Number.isSafeInteger(rateE8) || rateE8 <= 0) throw new Error('INVALID_EXCHANGE_RATE')
  return {
    rateE8,
    sourceDate: date!,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + 48 * 3600000, sourceTime + 72 * 3600000)).toISOString(),
  }
}
export async function exchangeRate(
  required = false,
  currency: ExchangeCurrency = 'USD',
): Promise<ExchangeRate | undefined> {
  requireCurrency(currency)
  if (currency === 'CNY')
    return {
      rateE8: 100000000,
      sourceDate: new Date().toISOString().slice(0, 10),
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
      source: 'CNY',
    }
  await db.exchangeRate.createMany({ data: [{ id: `${currency}_CNY` }], skipDuplicates: true })
  const row = await db.exchangeRate.findUnique({ where: { id: `${currency}_CNY` } })
  if (
    row?.rateE8 &&
    row.sourceDate &&
    row.fetchedAt &&
    row.expiresAt &&
    row.expiresAt.getTime() > Date.now()
  ) {
    return {
      rateE8: Number(row.rateE8),
      sourceDate: row.sourceDate,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      source: row.source ?? 'Currency API',
    }
  }
  if (required) throw new ApiError(503, '汇率正在更新，请稍后再试')
}
export async function exchangeRateStatus(
  currency: ExchangeCurrency = 'USD',
): Promise<NonNullable<AdminData['exchangeRate']>> {
  const row = await db.exchangeRate.findUnique({ where: { id: `${currency}_CNY` } })
  return {
    rate: row?.rateE8 ? Number(row.rateE8) / 100000000 : null,
    sourceDate: row?.sourceDate ?? null,
    fetchedAt: row?.fetchedAt?.toISOString() ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    available: !!row?.expiresAt && row.expiresAt.getTime() > Date.now(),
    lastError: row?.lastError ?? null,
    source: row?.source ?? null,
  }
}
export async function requestExchangeRefresh(currency: ExchangeCurrency = 'USD') {
  requireCurrency(currency)
  await db.exchangeRate.createMany({ data: [{ id: `${currency}_CNY` }], skipDuplicates: true })
  await db.exchangeRate.update({
    where: { id: `${currency}_CNY` },
    data: { refreshAfter: await databaseNow() },
  })
}
export async function refreshExchangeRate(currency: ExchangeCurrency = 'USD') {
  requireCurrency(currency)
  const pair = `${currency}_CNY`
  const lease = id('fx_')
  if (!(await claimExchangeRate(pair, lease))) return false
  for (const url of sourcesForCurrency(currency)) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('FETCH_FAILED')
      const text = await response.text()
      if (text.length > 100000) throw new Error('INVALID_RESPONSE')
      const rate = parseExchangeRate(JSON.parse(text), Date.now(), currency)
      const source = `Currency API · ${new URL(url).hostname === 'cdn.jsdelivr.net' ? 'jsDelivr' : 'Cloudflare'}`
      const result = await db.exchangeRate.updateMany({
        where: {
          id: pair,
          lease,
          OR: [{ sourceDate: null }, { sourceDate: { lte: rate.sourceDate } }],
        },
        data: {
          rateE8: BigInt(rate.rateE8),
          sourceDate: rate.sourceDate,
          fetchedAt: rate.fetchedAt,
          expiresAt: rate.expiresAt,
          source,
          lockedUntil: null,
          lastError: null,
          refreshAfter: new Date((await databaseNow()).getTime() + 3600_000),
        },
      })
      if (!result.count) throw new Error('OLDER_SOURCE_DATE')
      return true
    } catch {
      /* Try the provider's official mirror without exposing response bodies. */
    }
  }
  await db.exchangeRate.updateMany({
    where: { id: pair, lease },
    data: {
      lockedUntil: null,
      lastError: 'EXCHANGE_REFRESH_FAILED',
      refreshAfter: new Date((await databaseNow()).getTime() + 5 * 60_000),
    },
  })
  return true
}

export async function refreshPendingExchangeRates() {
  const now = await databaseNow()
  const due = await db.exchangeRate.findMany({
    where: {
      refreshAfter: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    orderBy: { refreshAfter: 'asc' },
    take: 8,
    select: { id: true },
  })
  // Bound concurrency; newly encountered quote currencies are filled by the worker.
  for (let i = 0; i < due.length; i += 2)
    await Promise.all(
      due.slice(i, i + 2).map(({ id }) => refreshExchangeRate(id.replace(/_CNY$/, ''))),
    )
}
