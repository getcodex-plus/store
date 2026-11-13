import type { PoolClient } from 'pg'
import type {
  AccountData,
  AdminData,
  Channel,
  Commission,
  Order,
  Product,
  Quote,
  Settings,
  User,
  Withdrawal,
  WithdrawalEstimate,
  WalletEntry,
} from '../types'
import { pool, rows, transaction } from './db'
import { ApiError, demo } from './config'
import { decrypt, encrypt, hash, id } from './crypto'
import { integration, integrationViews } from './integrations/config'
import { preflight, aicdk } from './integrations/aicdk'
import {
  createPayment,
  type PaymentOrder,
  type Provider,
  type Receipt,
} from './integrations/payments'
import { money, parseSession } from '../lib'
import { paymentLimitError, costBasedPrice, convertedSubscriptionPrice } from '../pricing'
import {
  exchangeRate,
  exchangeRateStatus,
  refreshExchangeRate,
  requestExchangeRefresh,
  type ExchangeRate,
} from './exchange-rates'
import { serviceTerms } from '../product-copy'
import { analyticsVisitor, funnelReport } from './funnel'
import type { FunnelSource } from '../funnel'
import { defaultReferralTiers, referralFunds, referralProgress } from '../referral'
import { withdrawalReviewSchema, withdrawalSchema } from './referral-policy'
import {
  withdrawalChannelError,
  withdrawalChannels,
  withdrawalFee,
  withdrawalRule,
  estimateUsdtAmount,
} from '../withdrawals'

export const orderColumns =
  'id,user_id,contact_email,product_id,product_name,email,amount,status,channel,created_at,completed_at,rate_bps,settlement_days,first_order_only,kind,balance_amount,external_amount,service_terms'
export async function settings(): Promise<Settings> {
  const result = await pool.query('SELECT body FROM settings WHERE id=1')
  if (!result.rows[0]) throw new ApiError(503, '请先初始化数据库')
  const conf: Settings = result.rows[0].body
  const referralTiers = conf.referralTiers ?? defaultReferralTiers
  return {
    ...conf,
    referralTiers,
    rateBps: referralTiers[0].rateBps,
    withdrawalChannels: withdrawalChannels(conf),
  }
}
async function qualifiedInvites(userId: string, client: PoolClient | typeof pool = pool) {
  // Contact email remains stable when a guest order is later claimed by its owner.
  const result = await client.query(
    `SELECT count(DISTINCT lower(COALESCE(o.contact_email,o.email)))::int AS n
     FROM commissions c JOIN orders o ON o.id=c.order_id
     WHERE c.user_id=$1 AND c.status='available' AND o.status='completed' AND o.kind='purchase'`,
    [userId],
  )
  return result.rows[0].n as number
}
export async function products(all = false): Promise<Product[]> {
  const catalog = await rows<Product>(
    `SELECT id,name,subtitle,description,price,features,plan,enabled,featured,upgrade,pricing_mode,price_currency,rounding_step,service_terms
     FROM products ${all ? '' : 'WHERE enabled=true'} ORDER BY upgrade, CASE plan WHEN 'go' THEN 0 WHEN 'plus' THEN 1 WHEN 'pro5' THEN 2 WHEN 'pro20' THEN 3 ELSE 4 END, price`,
  )
  if (all) return catalog
  const rate = catalog.some((p) => !p.upgrade && p.priceCurrency === 'USD')
    ? await exchangeRate()
    : undefined
  return catalog.map((product) => {
    if (product.upgrade) return { ...product, price: 0, priceCurrency: 'CNY' }
    if (product.priceCurrency === 'CNY') return product
    let price = 0
    if (rate) {
      try {
        price = convertedSubscriptionPrice(product.price, rate.rateE8, product.roundingStep)
      } catch {
        /* Unusable prices stay unavailable, never fall back to an unconverted amount. */
      }
    }
    return { ...product, price, priceCurrency: 'CNY', priceStatus: price ? 'ready' : 'pending' }
  })
}
export async function audit(actor: string, action: string, target: string, client: PoolClient) {
  await client.query('INSERT INTO audit(id,actor,action,target) VALUES($1,$2,$3,$4)', [
    id('a_'),
    actor,
    action,
    target,
  ])
}
export async function quote(
  productId: string,
  sessionText: string,
  browser: string,
  attribution: { source: FunnelSource; analytics: boolean } = {
    source: 'direct',
    analytics: false,
  },
): Promise<Quote> {
  let session: ReturnType<typeof parseSession>
  try {
    session = parseSession(sessionText)
  } catch (error) {
    throw new ApiError(400, (error as Error).message)
  }
  const product = (
    await rows<Product>('SELECT * FROM products WHERE id=$1 AND enabled=true', [productId])
  )[0]
  if (!product) throw new ApiError(404, '商品已下架')
  let stock: { id: string; code: string } | undefined
  let token = ''
  let amount = product.price
  let currentPlan: string | undefined
  let pricingSnapshot: unknown = { mode: 'fixed', price: product.price }
  let rate: ExchangeRate | undefined
  const configuredPricing = (await settings()).upgradePricing
  const pricing = product.upgrade
    ? configuredPricing
      ? { ...configuredPricing, ...configuredPricing.targets?.[product.plan] }
      : undefined
    : undefined
  if (
    product.upgrade &&
    (!pricing ||
      product.plan === 'go' ||
      (!demo && (!configuredPricing?.configured || !configuredPricing.targets?.[product.plan])))
  )
    throw new ApiError(409, '升级定价尚未配置或目标套餐不支持升级')
  if (!product.upgrade && product.pricingMode !== 'fixed')
    throw new ApiError(409, '此商品尚未配置固定售价')
  if (
    (!product.upgrade && product.priceCurrency === 'USD') ||
    (product.upgrade && (configuredPricing?.fxMode ?? 'auto') === 'auto')
  ) {
    rate = await exchangeRate(true)
  }
  if (!product.upgrade && product.priceCurrency === 'USD') {
    amount = convertedSubscriptionPrice(product.price, rate!.rateE8, product.roundingStep)
    pricingSnapshot = {
      mode: 'fixed',
      currency: 'USD',
      price: product.price,
      roundingStep: product.roundingStep,
      exchangeRate: rate,
    }
  }
  if (demo && product.upgrade) {
    amount = costBasedPrice(1000, pricing!, rate?.rateE8)
    currentPlan = product.upgrade ? 'plus' : 'free'
    pricingSnapshot = {
      mode: 'markup',
      source: 'demo',
      usdCents: 1000,
      ...pricing,
      exchangeRate: rate,
    }
  }
  const aicdkRevision = demo ? null : (await integration('aicdk')).id
  if (!demo) {
    stock = await transaction(async (client) => {
      // Only release expired quote reservations that never became an order.
      await client.query(`UPDATE inventory i SET status='available',reserved_until=null WHERE status='reserved' AND reserved_until<now()
        AND NOT EXISTS(SELECT 1 FROM quotes q JOIN orders o ON o.quote_id=q.id WHERE q.inventory_id=i.id AND o.status<>'cancelled')`)
      const item = (
        await rows<{ id: string; code: string }>(
          "SELECT id,code FROM inventory WHERE product_id=$1 AND status='available' FOR UPDATE SKIP LOCKED LIMIT 1",
          [productId],
          client,
        )
      )[0]
      if (!item) throw new ApiError(409, '此套餐暂时缺货，请稍后再试')
      await client.query(
        "UPDATE inventory SET status='reserved',reserved_until=now()+interval '15 minutes' WHERE id=$1",
        [item.id],
      )
      return item
    })
    try {
      const check = await preflight(decrypt(stock.code), session, aicdkRevision!)
      if (check.status !== 'ready' || !check.preflight_token)
        throw new ApiError(409, `账号正在核价，请 ${check.retry_after || 15} 秒后重试`)
      if (
        check.account_email &&
        check.account_email.toLowerCase() !== session.user.email.toLowerCase()
      )
        throw new ApiError(409, '预检账号不匹配')
      if (check.quote?.target_plan && check.quote.target_plan !== product.plan)
        throw new ApiError(409, '兑换库存与目标套餐不匹配，请联系支持')
      currentPlan = check.quote?.current_plan || check.currentPlan
      if (product.upgrade) {
        if (check.quote?.business !== 'upgrade' || check.quote.target_plan !== product.plan)
          throw new ApiError(409, '尚未取得有效升级报价，请稍后重试')
      }
      if (product.upgrade) {
        if (
          check.quote?.payment_usd_cents === undefined ||
          check.quote.target_plan !== product.plan
        )
          throw new ApiError(409, '未取得有效成本报价，请稍后重试')
        amount = costBasedPrice(check.quote.payment_usd_cents, pricing!, rate?.rateE8)
        pricingSnapshot = {
          mode: 'markup',
          usdCents: check.quote.payment_usd_cents,
          ...pricing,
          exchangeRate: rate,
        }
      }
      token = check.preflight_token
      if (rate && Date.parse(rate.expiresAt) <= Date.now())
        throw new ApiError(409, '汇率已过期，请重新验证账号')
    } catch (error) {
      await pool.query("UPDATE inventory SET status='available',reserved_until=null WHERE id=$1", [
        stock.id,
      ])
      throw error
    }
  }
  const q = {
    id: id('q_'),
    productId,
    email: session.user.email.toLowerCase(),
    amount,
    currentPlan,
    targetPlan: product.plan,
    serviceTerms: serviceTerms(product),
    expiresAt: new Date(
      Math.min(Date.now() + 9 * 60_000, rate ? Date.parse(rate.expiresAt) : Infinity),
    ).toISOString(),
  }
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO quotes(id,browser_digest,product_id,email,amount,inventory_id,preflight_token,expires_at,aicdk_integration_id,pricing_snapshot,current_plan,target_plan,service_terms,analytics_visitor,attribution_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        q.id,
        browser,
        q.productId,
        q.email,
        q.amount,
        stock?.id ?? null,
        token ? encrypt(token) : null,
        q.expiresAt,
        aicdkRevision,
        pricingSnapshot ? JSON.stringify(pricingSnapshot) : null,
        currentPlan ?? null,
        product.plan,
        q.serviceTerms,
        attribution.analytics ? analyticsVisitor(browser) : null,
        attribution.source,
      ],
    )
    if (attribution.analytics)
      await client.query(
        "INSERT INTO funnel_events(id,event,visitor_key,product_id,source) VALUES($1,'quote_ready',$2,$3,$4) ON CONFLICT DO NOTHING",
        [q.id, analyticsVisitor(browser), productId, attribution.source],
      )
    if (stock)
      await client.query('UPDATE inventory SET reserved_until=$2 WHERE id=$1', [
        stock.id,
        q.expiresAt,
      ])
  })
  return q
}
async function walletChange(
  client: PoolClient,
  userId: string,
  amount: number,
  kind: string,
  orderId: string,
) {
  await client.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING', [userId])
  const previous = await client.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [
    userId,
  ])
  const exists = await client.query('SELECT id FROM wallet_ledger WHERE order_id=$1 AND kind=$2', [
    orderId,
    kind,
  ])
  if (exists.rowCount) return
  const balance = previous.rows[0].balance + amount
  if (balance < 0) throw new ApiError(409, '钱包余额不足，请先充值或选择其他支付方式')
  await client.query('UPDATE wallets SET balance=$2 WHERE user_id=$1', [userId, balance])
  await client.query(
    'INSERT INTO wallet_ledger(id,user_id,amount,balance_after,kind,order_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id('l_'), userId, amount, balance, kind, orderId],
  )
}
export async function newOrder(
  user: User | null,
  browser: string,
  input: {
    quoteId?: string
    amount?: number
    channel: Channel
    requestKey: string
    contactEmail?: string
    balanceAmount?: number
    referralCode?: string
  },
) {
  if (!user && (!input.quoteId || input.channel === 'balance' || (input.balanceAmount ?? 0) > 0))
    throw new ApiError(401, '钱包功能需要先登录')
  if (!user && !input.contactEmail) throw new ApiError(400, '请填写联系邮箱以接收订单通知')
  const contactEmail = user?.email || input.contactEmail!
  const conf = await settings()
  if (!input.quoteId && (input.channel === 'balance' || (input.balanceAmount ?? 0) > 0))
    throw new ApiError(400, '不能用余额给余额充值')
  const provider =
    input.channel === 'crypto'
      ? 'gmpay'
      : input.channel === 'balance'
        ? 'balance'
        : conf.fiatProvider
  return transaction(async (client) => {
    // Per-user serialization also makes concurrent wallet purchases deterministic.
    if (user) await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id])
    else await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guest:${browser}`])
    const orderId = `o_${hash(`${user?.id || browser}:${input.requestKey}`).slice(0, 32)}`
    const requestHash = hash(
      JSON.stringify({
        quoteId: input.quoteId ?? null,
        amount: input.amount ?? null,
        channel: input.channel,
        contactEmail,
        balanceAmount: input.balanceAmount ?? 0,
        referralCode: input.referralCode ?? null,
      }),
    )
    const existing = (
      await rows<Order>(`SELECT ${orderColumns} FROM orders WHERE id=$1`, [orderId], client)
    )[0]
    if (existing) {
      const original = (
        await client.query('SELECT request_hash FROM orders WHERE id=$1', [orderId])
      ).rows[0]
      if (original.request_hash !== requestHash)
        throw new ApiError(409, '同一请求标识不能用于不同的订单参数')
      return existing
    }
    let quoteRecord: (Quote & { browserDigest: string; aicdkIntegrationId?: string }) | undefined
    let name = '钱包充值'
    if (input.quoteId) {
      quoteRecord = (
        await rows<Quote & { browserDigest: string; aicdkIntegrationId?: string }>(
          'SELECT * FROM quotes WHERE id=$1 FOR UPDATE',
          [input.quoteId],
          client,
        )
      )[0]
      if (!quoteRecord || quoteRecord.browserDigest !== browser)
        throw new ApiError(404, '未找到账号验证结果')
      const old = (
        await rows<Order>(
          `SELECT ${orderColumns} FROM orders WHERE quote_id=$1`,
          [quoteRecord.id],
          client,
        )
      )[0]
      if (old) {
        const original = (
          await client.query('SELECT request_hash,guest_browser_digest FROM orders WHERE id=$1', [
            old.id,
          ])
        ).rows[0]
        if (
          (user
            ? old.userId !== user.id
            : old.userId !== null || original.guest_browser_digest !== browser) ||
          original.request_hash !== requestHash
        )
          throw new ApiError(409, '此验证结果已被用于其他订单，请在原订单继续')
        return old
      }
      if (new Date(quoteRecord.expiresAt).getTime() < Date.now())
        throw new ApiError(409, '验证结果已过期，请重新验证账号')
      const product = (
        await rows<Product>(
          'SELECT * FROM products WHERE id=$1 AND enabled=true',
          [quoteRecord.productId],
          client,
        )
      )[0]
      if (!product) throw new ApiError(409, '商品已下架，请重新选择')
      if (quoteRecord.targetPlan && quoteRecord.targetPlan !== product.plan)
        throw new ApiError(409, '目标套餐已变更，请重新验证账号')
      name = product.name
    }
    const amount = quoteRecord?.amount ?? input.amount!
    const balanceAmount = input.channel === 'balance' ? amount : (input.balanceAmount ?? 0)
    if (!Number.isSafeInteger(balanceAmount) || balanceAmount < 0 || balanceAmount > amount)
      throw new ApiError(400, '余额抵扣金额无效')
    const externalAmount = amount - balanceAmount
    if (externalAmount > 0 && input.channel !== 'balance' && !conf[input.channel])
      throw new ApiError(409, '此支付方式暂未开放')
    const revision =
      demo || externalAmount === 0 || provider === 'balance'
        ? null
        : (await integration(provider)).id
    const limitError = paymentLimitError(conf, input.channel, externalAmount)
    if (limitError) throw new ApiError(409, limitError)
    const buyerKey = quoteRecord ? hash(`buyer:${quoteRecord.email.toLowerCase()}`) : null
    let inviterId: string | null = null
    if (quoteRecord) {
      // Existing account attribution wins. A guest can earn rewards without registering.
      const buyer = (
        await client.query('SELECT invited_by FROM users WHERE email=$1', [contactEmail])
      ).rows[0]
      const inviter = (
        await client.query(
          'SELECT id,email FROM users WHERE disabled=false AND (id=$1 OR ($1::text IS NULL AND referral_code=$2)) LIMIT 1',
          [buyer?.invited_by ?? null, input.referralCode ?? null],
        )
      ).rows[0]
      if (
        inviter &&
        inviter.id !== user?.id &&
        ![contactEmail, quoteRecord.email].includes(inviter.email)
      )
        inviterId = inviter.id
    }
    const referralRate = inviterId
      ? referralProgress(await qualifiedInvites(inviterId, client), conf).current.rateBps
      : conf.rateBps
    const order = (
      await rows<Order>(
        `INSERT INTO orders(id,user_id,quote_id,product_id,product_name,email,amount,status,channel,rate_bps,settlement_days,first_order_only,provider,integration_id,kind,request_hash,contact_email,guest_browser_digest,aicdk_integration_id,balance_amount,external_amount,inviter_id,buyer_key,service_terms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING ${orderColumns}`,
        [
          orderId,
          user?.id ?? null,
          quoteRecord?.id ?? null,
          quoteRecord?.productId ?? null,
          name,
          quoteRecord?.email ?? user!.email,
          amount,
          externalAmount === 0 ? 'processing' : 'unpaid',
          externalAmount === 0 ? 'balance' : input.channel,
          referralRate,
          conf.settlementDays,
          conf.firstOrderOnly,
          externalAmount === 0 ? 'balance' : provider,
          externalAmount === 0 ? null : revision,
          quoteRecord ? 'purchase' : 'topup',
          requestHash,
          contactEmail,
          user ? null : browser,
          quoteRecord?.aicdkIntegrationId ?? null,
          balanceAmount,
          externalAmount,
          inviterId,
          buyerKey,
          quoteRecord?.serviceTerms ?? '',
        ],
        client,
      )
    )[0]
    if (balanceAmount > 0)
      await walletChange(client, user!.id, -balanceAmount, 'purchase', order.id)
    if (externalAmount === 0) {
      await client.query('INSERT INTO jobs(id,order_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id('job_'),
        order.id,
      ])
    }
    return order
  })
}
export async function accessibleOrder(user: User | null, browser: string, orderId: string) {
  const order = (
    await rows<PaymentOrder>(
      'SELECT * FROM orders WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND guest_browser_digest=$3))',
      [orderId, user?.id ?? null, browser],
    )
  )[0]
  if (!order) throw new ApiError(404, '未找到订单，请使用联系邮箱登录，或使用下单时的浏览器')
  return order
}
export async function cancelOrder(user: User | null, browser: string, orderId: string) {
  await accessibleOrder(user, browser, orderId)
  return transaction(async (client) => {
    const order = (
      await rows<PaymentOrder>(
        'SELECT * FROM orders WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND guest_browser_digest=$3)) FOR UPDATE',
        [orderId, user?.id ?? null, browser],
        client,
      )
    )[0]
    if (!order) throw new ApiError(404, '未找到订单')
    if (order.status === 'cancelled') return { cancelled: true }
    // Once gateway creation starts, an unknown/late payment must be reconciled.
    if (order.status !== 'unpaid' || order.paymentAttempted)
      throw new ApiError(409, '支付已发起或订单已付款，请联系支持核对后处理，不能直接取消')
    if (order.balanceAmount > 0)
      await walletChange(client, order.userId!, order.balanceAmount, 'refund', order.id)
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [order.id])
    await client.query(
      "UPDATE inventory SET status='available',reserved_until=null WHERE id=(SELECT inventory_id FROM quotes WHERE id=$1)",
      [order.quoteId],
    )
    await client.query('UPDATE quotes SET preflight_token=null WHERE id=$1', [order.quoteId])
    return { cancelled: true }
  })
}
export async function paymentInfo(
  user: User | null,
  orderId: string,
  clientIP: string,
  browser = '',
) {
  const order = await accessibleOrder(user, browser, orderId)
  if (order.status === 'cancelled') throw new ApiError(409, '订单已取消')
  if (order.status !== 'unpaid') return { paid: true }
  if (demo && order.paymentAttempted) return { demo: true }
  if (order.paymentUrl) return { paymentUrl: order.paymentUrl }
  const claimed = await pool.query(
    "UPDATE orders SET payment_attempted=true WHERE id=$1 AND payment_attempted=false AND status='unpaid' RETURNING id",
    [order.id],
  )
  if (!claimed.rowCount)
    throw new ApiError(409, '支付单正在创建或结果待核对，请保留原订单并联系支持，不要重复付款')
  if (demo) return { demo: true }
  const payment = await createPayment(order, clientIP)
  await pool.query(
    'UPDATE orders SET payment_id=COALESCE(payment_id,$2),payment_url=$3 WHERE id=$1',
    [order.id, payment.paymentId, payment.paymentUrl],
  )
  return { paymentUrl: payment.paymentUrl }
}
export async function acceptPayment(provider: string, revision: string | null, receipt: Receipt) {
  if (
    !receipt.transactionId ||
    !receipt.orderId ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount <= 0
  )
    throw new ApiError(400, '回调字段不完整')
  return transaction(async (client) => {
    const order = (
      await rows<PaymentOrder>(
        'SELECT * FROM orders WHERE id=$1 FOR UPDATE',
        [receipt.orderId],
        client,
      )
    )[0]
    if (!order || order.provider !== provider || (order.integrationId ?? null) !== revision)
      throw new ApiError(400, '订单归属不匹配')
    if (
      order.externalAmount !== receipt.amount ||
      (receipt.channel && receipt.channel !== order.channel)
    )
      throw new ApiError(400, '付款信息不匹配')
    if (order.paymentId && order.paymentId !== receipt.transactionId)
      throw new ApiError(400, '支付交易号不匹配')
    if (!receipt.paid) return
    const previous = (
      await client.query(
        'SELECT order_id FROM payment_events WHERE provider=$1 AND transaction_id=$2',
        [provider, receipt.transactionId],
      )
    ).rows[0]
    if (previous) {
      if (previous.order_id !== order.id) throw new ApiError(409, '交易号已用于其他订单')
      return
    }
    if (order.status !== 'unpaid') throw new ApiError(409, '订单状态不允许收款')
    await client.query(
      'INSERT INTO payment_events(provider,transaction_id,order_id) VALUES($1,$2,$3)',
      [provider, receipt.transactionId, order.id],
    )
    if (order.kind === 'topup') {
      await walletChange(client, order.userId!, order.amount, 'topup', order.id)
      await client.query(
        "UPDATE orders SET status='completed',completed_at=now(),payment_id=$2 WHERE id=$1",
        [order.id, receipt.transactionId],
      )
    } else {
      await client.query("UPDATE orders SET status='processing',payment_id=$2 WHERE id=$1", [
        order.id,
        receipt.transactionId,
      ])
      await client.query('INSERT INTO jobs(id,order_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id('job_'),
        order.id,
      ])
    }
  })
}
export async function completeOrder(orderId: string) {
  await transaction(async (client) => {
    const initial = (
      await rows<PaymentOrder & { inviterId?: string; buyerKey?: string }>(
        'SELECT * FROM orders WHERE id=$1',
        [orderId],
        client,
      )
    )[0]
    if (!initial) return
    for (const key of [
      ...new Set([
        initial.buyerKey || hash(`buyer:${initial.email.toLowerCase()}`),
        hash(`contact:${initial.contactEmail.toLowerCase()}`),
      ]),
    ].sort())
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [initial.userId])
    const order = (
      await rows<PaymentOrder>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId], client)
    )[0]
    if (order.status === 'completed') return
    if (!['processing', 'needs_session'].includes(order.status) || order.kind !== 'purchase')
      throw new ApiError(409, '订单状态不允许完成')
    await client.query("UPDATE orders SET status='completed',completed_at=now() WHERE id=$1", [
      order.id,
    ])
    await client.query(
      "UPDATE inventory SET status='consumed',reserved_until=null WHERE id=(SELECT inventory_id FROM quotes WHERE id=$1)",
      [order.quoteId],
    )
    await client.query('UPDATE quotes SET preflight_token=null WHERE id=$1', [order.quoteId])
    const user = (await rows<User>('SELECT * FROM users WHERE id=$1', [order.userId], client))[0]
    const inviterId = initial.inviterId || (initial.buyerKey ? null : user?.invitedBy)
    if (inviterId && inviterId !== order.userId && order.rateBps > 0) {
      const previous = await client.query(
        "SELECT id FROM orders WHERE (email=$1 OR (user_id IS NOT NULL AND user_id=$3) OR contact_email=$4) AND status='completed' AND kind='purchase' AND id<>$2 LIMIT 1",
        [order.email, order.id, order.userId, order.contactEmail],
      )
      if (!order.firstOrderOnly || !previous.rowCount) {
        const amount = Math.floor((order.amount * order.rateBps) / 10000)
        if (amount > 0)
          await client.query(
            `INSERT INTO commissions(id,user_id,order_id,amount,status,available_at)
          VALUES($1,$2,$3,$4,'pending',now()+$5*interval '1 day') ON CONFLICT(order_id) DO NOTHING`,
            [id('c_'), inviterId, order.id, amount, order.settlementDays],
          )
      }
    }
  })
}
export async function account(user: User): Promise<AccountData> {
  const conf = await settings()
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const orders = await rows<Order>(
      `SELECT ${orderColumns} FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [user.id],
      client,
    )
    const commissions = await rows<Commission>(
      'SELECT * FROM commissions WHERE user_id=$1 ORDER BY created_at DESC',
      [user.id],
      client,
    )
    const withdrawals = await rows<Withdrawal>(
      'SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC',
      [user.id],
      client,
    )
    const invited = await client.query('SELECT count(*)::int AS n FROM users WHERE invited_by=$1', [
      user.id,
    ])
    const ledger = await rows<WalletEntry>(
      'SELECT * FROM wallet_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',
      [user.id],
      client,
    )
    const wallet = await client.query('SELECT balance FROM wallets WHERE user_id=$1', [user.id])
    const qualified = await qualifiedInvites(user.id, client)
    return {
      orders,
      commissions,
      withdrawals: withdrawals.map(withdrawalView),
      invitedCount: invited.rows[0].n,
      referral: referralProgress(qualified, conf),
      ...referralFunds(commissions, withdrawals),
      balance: wallet.rows[0]?.balance ?? 0,
      ledger,
    }
  })
}

function withdrawalView(withdrawal: Withdrawal): Withdrawal {
  // Never expose internal idempotency digests or encrypted payloads in account responses.
  return {
    id: withdrawal.id,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    method: withdrawal.method,
    account: decrypt(withdrawal.account, `withdrawal:${withdrawal.userId}`),
    recipientName: withdrawal.recipientName
      ? decrypt(withdrawal.recipientName, `withdrawal-name:${withdrawal.userId}`)
      : '',
    network: withdrawal.network,
    feeAmount: withdrawal.feeAmount,
    feeRateBps: withdrawal.feeRateBps,
    fixedFee: withdrawal.fixedFee,
    netAmount: withdrawal.amount - withdrawal.feeAmount,
    status: withdrawal.status,
    note: withdrawal.note,
    payoutReference: withdrawal.payoutReference,
    payoutAmount: withdrawal.payoutAmount,
    reviewerId: withdrawal.reviewerId,
    reviewedAt: withdrawal.reviewedAt,
    createdAt: withdrawal.createdAt,
  }
}

async function lockedReferralFunds(client: PoolClient, userId: string) {
  const commissions = await rows<Commission>(
    'SELECT amount,status FROM commissions WHERE user_id=$1 FOR UPDATE',
    [userId],
    client,
  )
  const withdrawals = await rows<Withdrawal>(
    'SELECT amount,status FROM withdrawals WHERE user_id=$1',
    [userId],
    client,
  )
  return referralFunds(commissions, withdrawals)
}

export async function withdraw(user: User, data: unknown) {
  const input = withdrawalSchema.parse(data)
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id])
    const requestKey = hash(`${user.id}:${input.requestKey}`)
    const requestHash = hash(
      JSON.stringify({
        amount: input.amount,
        method: input.method,
        account: input.account,
        recipientName: input.recipientName,
        network: input.network,
        ...(input.expectedFeeAmount ? { expectedFeeAmount: input.expectedFeeAmount } : {}),
      }),
    )
    const existing = (
      await rows<Withdrawal & { requestHash: string }>(
        'SELECT * FROM withdrawals WHERE request_key=$1',
        [requestKey],
        client,
      )
    )[0]
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, '同一请求标识不能用于不同的提现参数，请重新打开申请表')
      return withdrawalView(existing)
    }
    // Serialize new reservations with settings changes. Existing request retries
    // still resolve after a channel closes without reserving another amount.
    const configuration = await client.query('SELECT body FROM settings WHERE id=1 FOR SHARE')
    if (!configuration.rows[0]) throw new ApiError(503, '请先初始化数据库')
    const conf: Settings = configuration.rows[0].body
    const channelError = withdrawalChannelError(conf, input.method, input.network)
    if (channelError) throw new ApiError(409, channelError)
    const rule = withdrawalRule(conf, input.method, input.network)!
    if (input.amount < rule.minimum)
      throw new ApiError(400, `所选提现渠道最低起提 ${money(rule.minimum)}`)
    const fee = withdrawalFee(input.amount, rule)
    if (fee.netAmount <= 0) throw new ApiError(400, '扣除手续费后的到账金额必须大于 0')
    if (input.expectedFeeAmount !== fee.feeAmount)
      throw new ApiError(409, '提现手续费已调整，请核对新的手续费后重新确认')
    const funds = await lockedReferralFunds(client, user.id)
    if (input.amount > funds.available)
      throw new ApiError(409, '可提现邀请收益不足，请刷新额度；充值和退款余额不可提现')
    const withdrawal = (
      await rows<Withdrawal>(
        `INSERT INTO withdrawals(id,user_id,amount,method,account,request_key,request_hash,recipient_name,network,fee_amount,fee_rate_bps,fixed_fee)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id('w_'),
          user.id,
          input.amount,
          input.method,
          encrypt(input.account, `withdrawal:${user.id}`),
          requestKey,
          requestHash,
          encrypt(input.recipientName, `withdrawal-name:${user.id}`),
          input.network,
          fee.feeAmount,
          fee.feeRateBps,
          fee.fixedFee,
        ],
        client,
      )
    )[0]
    return withdrawalView(withdrawal)
  })
}

export async function withdrawalPayoutEstimate(
  withdrawalId: string,
  refresh = false,
): Promise<WithdrawalEstimate> {
  const withdrawal = (
    await rows<Withdrawal>('SELECT * FROM withdrawals WHERE id=$1', [withdrawalId])
  )[0]
  if (!withdrawal) throw new ApiError(404, '提现申请不存在')
  if (withdrawal.method !== 'USDT') throw new ApiError(400, '此申请无需 USDT 折算')
  if (!['pending', 'processing'].includes(withdrawal.status))
    throw new ApiError(409, '此申请已处理，无需估算打款数量')
  let rate = await exchangeRate(false, 'USDT')
  if (refresh || !rate) {
    if (refresh) await requestExchangeRefresh('USDT')
    await refreshExchangeRate('USDT')
    rate = await exchangeRate(false, 'USDT')
  }
  if (!rate) throw new ApiError(503, 'USDT 参考汇率暂不可用，请稍后刷新；仍可按实际打款数量登记')
  const netAmount = withdrawal.amount - withdrawal.feeAmount
  let estimatedUsdt: string
  try {
    estimatedUsdt = estimateUsdtAmount(netAmount, rate.rateE8)
  } catch {
    throw new ApiError(503, '参考转账数量超出支持范围，请核对汇率后重试')
  }
  return {
    withdrawalId,
    netAmount,
    estimatedUsdt,
    rate: rate.rateE8 / 100000000,
    source: rate.source ?? 'Currency API',
    sourceDate: rate.sourceDate,
    fetchedAt: rate.fetchedAt,
    expiresAt: rate.expiresAt,
    refreshFailed: !!(await exchangeRateStatus('USDT')).lastError,
  }
}

export async function reviewWithdrawal(actor: User, data: unknown) {
  const input = withdrawalReviewSchema.parse(data)
  return transaction(async (client) => {
    const owner = (await client.query('SELECT user_id FROM withdrawals WHERE id=$1', [input.id]))
      .rows[0]
    if (!owner) throw new ApiError(404, '提现申请不存在')
    // All reservation and review transitions take the same user lock first.
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user_id])
    const current = (
      await rows<Withdrawal>('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE', [input.id], client)
    )[0]
    if (!['pending', 'processing'].includes(current.status))
      throw new ApiError(409, '该提现已处理，请刷新')
    if (current.status === 'processing' && current.reviewerId !== actor.id)
      throw new ApiError(409, '该申请已由其他管理员受理，请由受理人完成处理')
    if (input.status === 'processing' && current.status !== 'pending')
      throw new ApiError(409, '该申请已受理，请刷新')
    if (input.status === 'paid' && current.status !== 'processing')
      throw new ApiError(409, '请先受理申请，核对收款信息后再登记实际打款')
    if (input.status !== 'rejected') {
      const funds = await lockedReferralFunds(client, current.userId)
      if (funds.shortfall > 0)
        throw new ApiError(409, '邀请收益发生冲回，额度不足；请先拒绝超额申请释放冻结额度')
    }
    let payoutAmount: number | null = null
    if (input.status === 'paid') {
      if (current.method === 'USDT' && !input.payoutAmount)
        throw new ApiError(400, '请填写实际到账 USDT 数量')
      payoutAmount =
        current.method === 'USDT' ? input.payoutAmount! : (current.amount - current.feeAmount) / 100
      if (
        payoutAmount < 0.000001 ||
        Math.abs(payoutAmount * 1000000 - Math.round(payoutAmount * 1000000)) > 0.0001
      )
        throw new ApiError(400, 'USDT 数量最多保留 6 位小数')
    }
    await client.query(
      `UPDATE withdrawals SET status=$2,note=$3,reviewer_id=$4,reviewed_at=now(),
       payout_reference=$5,payout_amount=$6 WHERE id=$1`,
      [
        input.id,
        input.status,
        input.note,
        actor.id,
        input.status === 'paid' ? input.payoutReference : '',
        payoutAmount,
      ],
    )
    await audit(
      actor.email,
      {
        processing: '受理提现，待人工打款',
        paid: '登记提现打款',
        rejected: '拒绝提现，释放邀请额度',
      }[input.status],
      input.id,
      client,
    )
    return { saved: true }
  }).catch((error) => {
    if ((error as { code?: string }).code === '23505')
      throw new ApiError(409, '此打款流水号已登记，请核对后刷新')
    throw error
  })
}
export async function adminData(
  actor: User,
): Promise<
  AdminData & { integrations: Awaited<ReturnType<typeof integrationViews>>; roles: unknown[] }
> {
  const [users, allProducts, orders, commissions, withdrawals, conf, log, inventory, integrations] =
    await Promise.all([
      rows<User>(
        "SELECT u.*,COALESCE((SELECT jsonb_agg(role_id) FROM user_roles WHERE user_id=u.id),'[]') AS role_ids FROM users u ORDER BY created_at DESC LIMIT 500",
      ),
      products(true),
      rows<Order>(`SELECT ${orderColumns} FROM orders ORDER BY created_at DESC LIMIT 500`),
      rows<Commission>('SELECT * FROM commissions ORDER BY created_at DESC LIMIT 500'),
      rows<Withdrawal>('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 500'),
      settings(),
      rows<AdminData['audit'][number]>('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100'),
      rows<
        AdminData['inventory'][number]
      >(`SELECT product_id,count(*) FILTER(WHERE status='available')::int AS available,
      count(*) FILTER(WHERE status='reserved')::int AS reserved,count(*) FILTER(WHERE status='consumed')::int AS consumed FROM inventory GROUP BY product_id`),
      actor.permissions.includes('integrations:read') ? integrationViews() : Promise.resolve([]),
    ])
  const can = (permission: string) => actor.permissions.includes(permission)
  const { upgradePricing: _pricing, ...publicSettings } = conf
  return {
    funnel: can('orders:read') ? await funnelReport() : undefined,
    exchangeRate: can('settings:read') ? await exchangeRateStatus() : undefined,
    users: can('users:read') ? users : [],
    products: can('products:read') ? allProducts : [],
    orders: can('orders:read')
      ? orders
      : can('wallet:read')
        ? orders.filter((o) => o.kind === 'topup' || o.balanceAmount > 0)
        : [],
    commissions: can('referral:read') ? commissions : [],
    withdrawals: can('withdrawals:read') ? withdrawals.map(withdrawalView) : [],
    settings: can('settings:read') ? conf : publicSettings,
    audit: can('audit:read') ? log : [],
    inventory: can('products:read') ? inventory : [],
    integrations,
    roles: can('roles:read') ? await rows('SELECT * FROM roles ORDER BY id') : [],
  }
}
export async function refundFailedOrder(orderId: string, actor: string) {
  await transaction(async (client) => {
    const order = (
      await rows<Order>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId], client)
    )[0]
    if (!order) throw new ApiError(404, '订单不存在')
    if (order.status === 'refunded') return
    if (order.status !== 'failed' || order.kind !== 'purchase')
      throw new ApiError(409, '仅已确认失败的套餐订单可退回钱包')
    if (!order.userId) throw new ApiError(409, '请联系用户先用联系邮箱登录，以接收钱包退款')
    await walletChange(client, order.userId, order.amount, 'refund', order.id)
    await client.query("UPDATE orders SET status='refunded' WHERE id=$1", [order.id])
    await client.query('UPDATE jobs SET done=true WHERE order_id=$1', [order.id])
    await client.query("UPDATE commissions SET status='reversed' WHERE order_id=$1", [order.id])
    await audit(actor, '失败订单退回钱包', order.id, client)
  })
  return { refunded: true }
}
export async function confirmSession(
  user: User | null,
  orderId: string,
  sessionText: string,
  browser = '',
) {
  const session = parseSession(sessionText)
  const order = await accessibleOrder(user, browser, orderId)
  if (!order || order.status !== 'needs_session')
    throw new ApiError(409, '当前订单不需要更新账号信息')
  if (session.user.email.toLowerCase() !== order.email)
    throw new ApiError(400, '请使用原充值账号的信息')
  if (!demo) {
    if (!order.redemptionId) {
      const recovered = await aicdk<{ id: string }[]>(
        `/redemptions?client_request_id=${encodeURIComponent(order.id)}`,
        undefined,
        undefined,
        order.aicdkIntegrationId,
      )
      if (recovered[0]?.id) {
        order.redemptionId = recovered[0].id
        await pool.query('UPDATE orders SET redemption_id=$2 WHERE id=$1', [
          order.id,
          order.redemptionId,
        ])
      }
    }
    if (order.redemptionId)
      await aicdk(
        `/redemptions/${encodeURIComponent(order.redemptionId)}/confirm`,
        { session },
        `${order.id}-confirm-${hash(sessionText).slice(0, 20)}`,
        order.aicdkIntegrationId,
      )
    else {
      const stock = (
        await pool.query(
          'SELECT i.code FROM inventory i JOIN quotes q ON q.inventory_id=i.id WHERE q.id=$1',
          [order.quoteId],
        )
      ).rows[0]
      if (!stock) throw new ApiError(409, '订单库存需由管理员核对')
      const result = await preflight(decrypt(stock.code), session, order.aicdkIntegrationId)
      if (result.status !== 'ready' || !result.preflight_token)
        throw new ApiError(409, '账号正在核价，请稍后重试')
      await transaction(async (client) => {
        const claimed = await client.query(
          "UPDATE orders SET status='processing',fulfillment_attempt=fulfillment_attempt+1 WHERE id=$1 AND status='needs_session' RETURNING id",
          [order.id],
        )
        if (claimed.rowCount)
          await client.query(
            "UPDATE quotes SET preflight_token=$2,expires_at=now()+interval '9 minutes' WHERE id=$1",
            [order.quoteId, encrypt(result.preflight_token!)],
          )
      })
    }
  }
  await pool.query("UPDATE orders SET status='processing' WHERE id=$1 AND status='needs_session'", [
    order.id,
  ])
  await pool.query('UPDATE jobs SET done=false,run_at=now(),locked_until=null WHERE order_id=$1', [
    order.id,
  ])
  return { resumed: true }
}
