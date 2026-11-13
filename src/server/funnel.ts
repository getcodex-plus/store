import { pool, rows } from './db'
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
  await pool.query(
    `INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
     SELECT $1,$2,$3,id,$5 FROM products WHERE id=$4 AND enabled=true ON CONFLICT DO NOTHING`,
    [key, event, visitor, productId, source],
  )
}
export async function funnelReport(): Promise<FunnelRow[]> {
  return rows<FunnelRow>(
    `SELECT event,source,count(*)::int AS events,count(DISTINCT visitor_key)::int AS visitors
     FROM funnel_events WHERE created_at>=now()-interval '30 days' GROUP BY event,source ORDER BY event,source`,
  )
}
