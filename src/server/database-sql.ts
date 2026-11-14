// PostgreSQL locking, clock and aggregate operations. Runtime raw SQL lives here;
// ordinary reads and writes use Prisma models at their business call sites.
import { db, Prisma, type DbClient } from './db'
import type { FunnelRow } from '../funnel'

const lockTables = {
  users: Prisma.raw('"users"'),
  wallets: Prisma.raw('"wallets"'),
  orders: Prisma.raw('"orders"'),
  quotes: Prisma.raw('"quotes"'),
  inventory: Prisma.raw('"inventory"'),
  roles: Prisma.raw('"roles"'),
  withdrawals: Prisma.raw('"withdrawals"'),
}

export async function lockRow(
  client: DbClient,
  table: keyof typeof lockTables,
  id: string | null | undefined,
) {
  if (id == null) return
  const key = table === 'wallets' ? Prisma.raw('"user_id"') : Prisma.raw('"id"')
  await client.$queryRaw(
    Prisma.sql`SELECT ${key} FROM ${lockTables[table]} WHERE ${key}=${id} FOR UPDATE`,
  )
}

export async function lockSettings(client: DbClient, mode: 'update' | 'share' = 'update') {
  await client.$queryRaw(
    Prisma.sql`SELECT id FROM settings WHERE id=1 ${mode === 'share' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`}`,
  )
}

export async function advisoryLock(client: DbClient, key: string) {
  // PostgreSQL void is unsupported by Prisma's raw result deserializer.
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}

export async function databaseNow(client: DbClient = db) {
  const [row] = await client.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`
  return row.now
}

export async function lockCommissions(client: DbClient, userId: string) {
  await client.$queryRaw`SELECT id FROM commissions WHERE user_id=${userId} FOR UPDATE`
}

export async function lockIntegration(client: DbClient, provider: string) {
  await client.$queryRaw`SELECT id FROM integrations WHERE provider=${provider} AND active=true FOR UPDATE`
}

// Must run inside the order transaction. Keep the row lock through preflight,
// quote binding and order creation; any failure rolls the reservation back.
export async function reserveInventory(client: DbClient, productId: string) {
  const [stock] = await client.$queryRaw<{ id: string }[]>`SELECT i.id FROM inventory i
    WHERE i.product_id=${productId}
      AND (i.status='available' OR (i.status='reserved' AND i.reserved_until<now()))
      AND NOT EXISTS(SELECT 1 FROM quotes q JOIN orders o ON o.quote_id=q.id
        WHERE q.inventory_id=i.id AND o.status<>'cancelled')
    ORDER BY i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`
  if (!stock) return null
  // Recover only the chosen expired reservation. A bulk expiry UPDATE would
  // wait on other checkouts before SKIP LOCKED ever gets a chance to run.
  return client.inventory.update({
    where: { id: stock.id },
    data: { status: 'reserved', reservedUntil: null },
  })
}

export async function qualifiedInvitesSql(client: DbClient, userId: string) {
  const [result] = await client.$queryRaw<
    { n: number }[]
  >`SELECT count(DISTINCT lower(COALESCE(o.contact_email,o.email)))::int AS n
    FROM commissions c JOIN orders o ON o.id=c.order_id
    WHERE c.user_id=${userId} AND c.status='available' AND o.status='completed' AND o.kind='purchase'`
  return result.n
}

export async function incrementRateLimit(key: string, seconds: number) {
  const [result] = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO rate_limits(key,count,expires_at)
    VALUES(${key},1,now()+${seconds}::int*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END,
      expires_at=CASE WHEN rate_limits.expires_at<now() THEN excluded.expires_at ELSE rate_limits.expires_at END
    RETURNING count`
  return result.count
}

export async function recordViewSql(
  id: string,
  event: string,
  visitor: string,
  productId: string,
  source: string,
) {
  await db.$executeRaw`INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    SELECT ${id},${event},${visitor},id,${source} FROM products
    WHERE id=${productId} AND enabled=true ON CONFLICT DO NOTHING`
}

export async function funnelReportSql(): Promise<FunnelRow[]> {
  return db.$queryRaw<FunnelRow[]>`SELECT event,source,count(*)::int AS events,
    count(DISTINCT visitor_key)::int AS visitors FROM funnel_events
    WHERE created_at>=now()-interval '30 days' GROUP BY event,source ORDER BY event,source`
}

export async function claimEmail() {
  const [claimed] = await db.$queryRaw<{ id: string }[]>`UPDATE email_outbox
    SET run_at=now()+interval '2 minutes',attempts=attempts+1
    WHERE id=(SELECT id FROM email_outbox WHERE sent_at IS NULL AND run_at<=now()
      ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`
  return claimed ? db.emailOutbox.findUnique({ where: { id: claimed.id } }) : null
}

export async function claimJob(client: DbClient, lease: string) {
  const [claimed] = await client.$queryRaw<{ id: string }[]>`SELECT id FROM jobs
    WHERE done=false AND run_at<=now() AND (locked_until IS NULL OR locked_until<now())
    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1`
  if (!claimed) return null
  const job = await client.job.findUniqueOrThrow({ where: { id: claimed.id } })
  await client.$executeRaw`UPDATE jobs SET locked_until=now()+interval '2 minutes',
    lease=${lease},attempts=attempts+1 WHERE id=${job.id}`
  return job
}

export async function claimExchangeRate(pair: string, lease: string) {
  return db.$executeRaw`UPDATE exchange_rates SET lease=${lease},locked_until=now()+interval '45 seconds'
    WHERE id=${pair} AND refresh_after<=now() AND (locked_until IS NULL OR locked_until<now())`
}

export async function savePaymentLocation(orderId: string, paymentId: string, paymentUrl: string) {
  await db.$executeRaw`UPDATE orders SET payment_id=COALESCE(payment_id,${paymentId}),
    payment_url=${paymentUrl} WHERE id=${orderId}`
}

export async function readOnlyTransaction(client: DbClient) {
  await client.$executeRaw`SET TRANSACTION READ ONLY`
}

export async function lockCredentialTables(client: DbClient) {
  await client.$executeRaw`LOCK TABLE inventory, quotes IN SHARE ROW EXCLUSIVE MODE`
}
