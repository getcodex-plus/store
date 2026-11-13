import { recordViewSql, funnelReportSql } from './database-sql'
import { hash } from './crypto'
import type { ClientEvent, FunnelRow, FunnelSource } from '../funnel'

export function analyticsVisitor(browser: string) {
  return hash(`funnel:${browser}`)
}
export async function recordView(
  browser: string,
  event: ClientEvent,
  productId: string,
  source: FunnelSource,
) {
  const visitor = analyticsVisitor(browser)
  const key = hash(`${visitor}:${new Date().toISOString().slice(0, 10)}:${event}:${productId}`)
  await recordViewSql(key, event, visitor, productId, source)
}
export async function funnelReport(): Promise<FunnelRow[]> {
  return funnelReportSql()
}
