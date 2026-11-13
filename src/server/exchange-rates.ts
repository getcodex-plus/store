import { pool, rows } from './db'
import { id } from './crypto'
import { ApiError } from './config'
import type { AdminData } from '../types'

export const exchangeSources = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
] as const
export interface ExchangeRate {
  rateE8: number
  sourceDate: string
  fetchedAt: string
  expiresAt: string
}
interface RateRow {
  rateE8: string | null
  sourceDate: string | null
  fetchedAt: string | null
  expiresAt: string | null
  lastError: string | null
}
export function parseExchangeRate(input: unknown, now = Date.now()): ExchangeRate {
  const data = input as { date?: string; usd?: { cny?: number } } | null
  const date = data?.date
  const rate = data?.usd?.cny
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
export async function exchangeRate(required = false): Promise<ExchangeRate | undefined> {
  const row = (await rows<RateRow>("SELECT * FROM exchange_rates WHERE id='USD_CNY'"))[0]
  if (
    row?.rateE8 &&
    row.sourceDate &&
    row.fetchedAt &&
    row.expiresAt &&
    Date.parse(row.expiresAt) > Date.now()
  ) {
    return {
      rateE8: Number(row.rateE8),
      sourceDate: row.sourceDate,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
    }
  }
  if (required) throw new ApiError(503, '汇率正在更新，请稍后再试')
}
export async function exchangeRateStatus(): Promise<AdminData['exchangeRate']> {
  const row = (await rows<RateRow>("SELECT * FROM exchange_rates WHERE id='USD_CNY'"))[0]
  return {
    rate: row?.rateE8 ? Number(row.rateE8) / 100000000 : null,
    sourceDate: row?.sourceDate ?? null,
    fetchedAt: row?.fetchedAt ?? null,
    expiresAt: row?.expiresAt ?? null,
    available: !!row?.expiresAt && Date.parse(row.expiresAt) > Date.now(),
    lastError: row?.lastError ?? null,
  }
}
export async function requestExchangeRefresh() {
  await pool.query("UPDATE exchange_rates SET refresh_after=now() WHERE id='USD_CNY'")
}
export async function refreshExchangeRate() {
  const lease = id('fx_')
  const claim = await pool.query(
    `UPDATE exchange_rates SET lease=$1,locked_until=now()+interval '45 seconds'
     WHERE id='USD_CNY' AND refresh_after<=now()
       AND (locked_until IS NULL OR locked_until<now()) RETURNING id`,
    [lease],
  )
  if (!claim.rowCount) return false
  for (const url of exchangeSources) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('FETCH_FAILED')
      const text = await response.text()
      if (text.length > 100000) throw new Error('INVALID_RESPONSE')
      const rate = parseExchangeRate(JSON.parse(text))
      const result = await pool.query(
        `UPDATE exchange_rates SET rate_e8=$2,source_date=$3,fetched_at=$4,expires_at=$5,
         locked_until=null,last_error=null,refresh_after=now()+interval '1 hour'
         WHERE id='USD_CNY' AND lease=$1 AND (source_date IS NULL OR source_date<=$3) RETURNING id`,
        [lease, rate.rateE8, rate.sourceDate, rate.fetchedAt, rate.expiresAt],
      )
      if (!result.rowCount) throw new Error('OLDER_SOURCE_DATE')
      return true
    } catch {
      /* Try the provider's official mirror without exposing response bodies. */
    }
  }
  await pool.query(
    `UPDATE exchange_rates SET locked_until=null,last_error='EXCHANGE_REFRESH_FAILED',
     refresh_after=now()+interval '5 minutes' WHERE id='USD_CNY' AND lease=$1`,
    [lease],
  )
  return true
}
