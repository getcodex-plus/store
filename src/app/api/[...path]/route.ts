import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { bodyText, failure, guard } from '../../../server/http'
import { ApiError, demo } from '../../../server/config'
import {
  browserDigest,
  currentUser,
  rateLimit,
  requireUser,
  requireRecent,
} from '../../../server/auth'
import {
  accessibleOrder,
  cancelOrder,
  account,
  adminData,
  audit,
  completeOrder,
  confirmSession,
  newOrder,
  orderColumns,
  paymentInfo,
  products,
  quote,
  settings,
  withdraw,
  acceptPayment,
  refundFailedOrder,
} from '../../../server/services'
import { pool, rows, transaction } from '../../../server/db'
import { normalizeDemoSession } from '../../../lib'
import { requestExchangeRefresh } from '../../../server/exchange-rates'
import { decrypt, encrypt, hash, id } from '../../../server/crypto'
import { integrationSchema, saveIntegration } from '../../../server/integrations/config'
import type { PaymentOrder } from '../../../server/integrations/payments'
import type { Order, Product } from '../../../types'
import { authorize, mayGrant, permissions, type Permission } from '../../../server/rbac'
import { requireTurnstile, turnstilePublic } from '../../../server/turnstile'
import { setPassword, securityStatus } from '../../../server/security'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const emailSchema = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase().trim())
const roundingSchema = z
  .union([z.literal(1), z.literal(10), z.literal(100), z.literal(1000)])
  .default(100)
const productSchema = z
  .object({
    id: z.string().regex(/^[a-z\d_-]{1,64}$/),
    name: z.string().min(1).max(80),
    subtitle: z.string().max(100),
    description: z.string().max(500),
    price: z.number().int().min(1).max(100000000),
    features: z.array(z.string().min(1).max(100)).min(1).max(8),
    plan: z.enum(['go', 'plus', 'pro5', 'pro20', 'promax']),
    enabled: z.boolean(),
    featured: z.boolean(),
    upgrade: z.boolean(),
    pricingMode: z.enum(['fixed', 'markup']),
    priceCurrency: z.enum(['CNY', 'USD']).default('CNY'),
    roundingStep: roundingSchema,
  })
  .refine((p) => !(p.upgrade && p.plan === 'go'), { message: 'Go 不支持作为升级目标' })
  .refine((p) => !p.upgrade || p.pricingMode === 'markup', {
    message: '升级商品必须按成本加价报价',
  })
  .refine((p) => p.upgrade || p.pricingMode === 'fixed', {
    message: '订阅充值仅支持固定售价',
  })
const limitSchema = z
  .object({
    min: z.number().int().min(1).max(100000000),
    max: z.number().int().min(1).max(100000000),
  })
  .refine((v) => v.min <= v.max, { message: '最低金额不能高于最高金额' })
async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    guard(request)
    const path = (await context.params).path.join('/')
    const data = request.method === 'GET' ? {} : JSON.parse((await bodyText(request)) || '{}')
    const method = request.method
    let result: unknown
    if (path === 'bootstrap' && method === 'GET') {
      await browserDigest()
      const [user, catalog, conf] = await Promise.all([currentUser(), products(), settings()])
      const { upgradePricing: _pricing, ...publicSettings } = conf
      result = {
        mode: demo ? 'demo' : 'live',
        user,
        products: catalog,
        settings: publicSettings,
        turnstile: await turnstilePublic(),
      }
    } else if (path === 'demo/code' && method === 'POST' && demo) {
      const { email } = z.object({ email: emailSchema }).parse(data)
      const record = (
        await pool.query(
          'SELECT code FROM demo_mailbox WHERE browser_digest=$1 AND email=$2 AND expires_at>now()',
          [await browserDigest(), email],
        )
      ).rows[0]
      result = { demoCode: record ? decrypt(record.code, 'demo-email') : null }
    } else if (path === 'security' && method === 'GET')
      result = await securityStatus(await requireUser())
    else if (path === 'security/password' && method === 'POST') {
      result = await setPassword(
        await requireUser(),
        z.object({ password: z.string().min(12).max(128) }).parse(data).password,
      )
    } else if (path === 'quotes' && method === 'POST') {
      await requireTurnstile('purchase', data.turnstileToken)
      const input = z
        .object({
          productId: z.string().max(64),
          session: z.string().min(1).max(100000),
        })
        .parse(data)
      const browser = await browserDigest()
      await rateLimit(`quote:${browser}`, 6, 60)
      if (!demo) await rateLimit('aicdk:preflight', 6, 60)
      let text = input.session
      if (demo) {
        try {
          text = normalizeDemoSession(text)
        } catch (error) {
          throw new ApiError(400, (error as Error).message)
        }
      }
      result = await quote(input.productId, text, browser)
    } else if (path === 'orders' && method === 'POST') {
      await requireTurnstile('purchase', data.turnstileToken)
      const input = z
        .object({
          quoteId: z.string().optional(),
          amount: z.number().int().min(100).max(1000000).optional(),
          channel: z.enum(['alipay', 'wechat', 'crypto', 'balance']),
          requestKey: z.string().min(16).max(128),
          contactEmail: emailSchema.optional(),
          balanceAmount: z.number().int().min(0).max(100000000).optional(),
          referralCode: z
            .string()
            .regex(/^[a-z\d]{10,12}$/)
            .optional(),
        })
        .refine((v) => Boolean(v.quoteId) !== Boolean(v.amount), {
          message: '请选择商品订单或钱包充值',
        })
        .parse(data)
      await rateLimit(`order:${await browserDigest()}`, 12, 600)
      if (input.contactEmail) await rateLimit(`guest-contact:${hash(input.contactEmail)}`, 5, 600)
      result = await newOrder(await currentUser(), await browserDigest(), input)
    } else if (/^orders\/[^/]+$/.test(path) && method === 'GET') {
      const order = await accessibleOrder(
        await currentUser(),
        await browserDigest(),
        path.split('/')[1],
      )
      result = (await rows<Order>(`SELECT ${orderColumns} FROM orders WHERE id=$1`, [order.id]))[0]
    } else if (/^orders\/[^/]+\/cancel$/.test(path) && method === 'POST') {
      result = await cancelOrder(await currentUser(), await browserDigest(), path.split('/')[1])
    } else if (/^orders\/[^/]+\/pay$/.test(path) && method === 'POST') {
      const user = await currentUser()
      const clientIP =
        process.env.TRUST_PROXY === 'true' ? request.headers.get('x-real-ip') || '' : '127.0.0.1'
      result = await paymentInfo(user, path.split('/')[1], clientIP, await browserDigest())
    } else if (/^orders\/[^/]+\/demo-pay$/.test(path) && method === 'POST') {
      if (!demo) throw new ApiError(404, '不存在')
      const user = await currentUser()
      const order = await accessibleOrder(user, await browserDigest(), path.split('/')[1])
      await acceptPayment(order.provider, null, {
        orderId: order.id,
        transactionId: `demo-${order.id}`,
        amount: order.externalAmount,
        paid: true,
      })
      if (order.kind === 'purchase') await completeOrder(order.id)
      result = { ok: true }
    } else if (/^orders\/[^/]+\/session$/.test(path) && method === 'POST') {
      const input = z.object({ session: z.string().max(100000) }).parse(data)
      result = await confirmSession(
        await currentUser(),
        path.split('/')[1],
        input.session,
        await browserDigest(),
      )
    } else if (path === 'account' && method === 'GET') result = await account(await requireUser())
    else if (path === 'wallet/withdraw' && method === 'POST') {
      const user = await requireUser()
      await requireRecent(user)
      await withdraw(
        user,
        z
          .object({
            amount: z.number().int().positive().max(100000000),
            method: z.enum(['支付宝', '微信', 'USDT']),
            account: z.string().trim().min(3).max(250),
            requestKey: z.string().min(16).max(128),
          })
          .parse(data),
      )
      result = { submitted: true }
    } else if (path.startsWith('admin')) {
      const admin = await requireUser(true)
      const permissionMap: Record<string, Permission> = {
        'admin/integrations': 'integrations:write',
        'admin/products': 'products:write',
        'admin/inventory': 'products:write',
        'admin/settings': 'settings:write',
        'admin/exchange-rates/refresh': 'settings:write',
        'admin/users': 'users:write',
        'admin/withdrawals': 'withdrawals:write',
        'admin/orders/retry': 'orders:write',
        'admin/orders/refund': 'orders:write',
        'admin/roles': 'roles:write',
        'admin/user-roles': 'roles:write',
      }
      if (method === 'POST') {
        const required = permissionMap[path]
        if (!required) throw new ApiError(404, '接口不存在')
        authorize(admin, required)
        if (['integrations:write', 'roles:write', 'withdrawals:write'].includes(required))
          await requireRecent(admin)
      }
      if (path === 'admin' && method === 'GET') result = await adminData(admin)
      else if (path === 'admin/integrations' && method === 'POST')
        result = await saveIntegration(integrationSchema.parse(data), admin.email)
      else if (path === 'admin/roles' && method === 'POST') {
        const input = z
          .object({
            id: z.string().regex(/^[a-z\d_-]{1,50}$/),
            name: z.string().min(1).max(80),
            permissions: z.array(z.enum(permissions)),
          })
          .parse(data)
        mayGrant(admin, input.permissions)
        await transaction(async (client) => {
          const existing = (
            await client.query('SELECT * FROM roles WHERE id=$1 FOR UPDATE', [input.id])
          ).rows[0]
          if (existing?.protected) throw new ApiError(403, '内置角色不可修改')
          if (existing) mayGrant(admin, existing.permissions)
          await client.query(
            'INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions',
            [input.id, input.name, JSON.stringify(input.permissions)],
          )
          await audit(admin.email, '更新角色', input.id, client)
        })
        result = { saved: true }
      } else if (path === 'admin/user-roles' && method === 'POST') {
        const input = z
          .object({ userId: z.string(), roleIds: z.array(z.string()).max(20) })
          .parse(data)
        await transaction(async (client) => {
          const user = (
            await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [input.userId])
          ).rows[0]
          if (!user || user.role === 'admin') throw new ApiError(403, '内置管理员角色受保护')
          const roles = (
            await client.query('SELECT permissions FROM roles WHERE id=ANY($1::text[])', [
              input.roleIds,
            ])
          ).rows
          if (roles.length !== new Set(input.roleIds).size) throw new ApiError(400, '角色不存在')
          const old = (
            await client.query(
              'SELECT r.permissions FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1',
              [input.userId],
            )
          ).rows
          mayGrant(
            admin,
            [...roles, ...old].flatMap((r) => r.permissions),
          )
          await client.query('DELETE FROM user_roles WHERE user_id=$1', [input.userId])
          for (const roleId of new Set(input.roleIds))
            await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [
              input.userId,
              roleId,
            ])
          await client.query('DELETE FROM auth_session WHERE "userId"=$1', [input.userId])
          await audit(admin.email, '分配用户角色', input.userId, client)
        })
        result = { saved: true }
      } else if (path === 'admin/orders/refund' && method === 'POST') {
        await requireRecent(admin)
        result = await refundFailedOrder(z.object({ id: z.string() }).parse(data).id, admin.email)
      } else if (path === 'admin/exchange-rates/refresh' && method === 'POST') {
        await rateLimit(`fx-refresh:${admin.id}`, 6, 60)
        await requestExchangeRefresh()
        await transaction((client) => audit(admin.email, '请求刷新汇率', 'USD_CNY', client))
        result = { queued: true }
      } else if (path === 'admin/products' && method === 'POST') {
        const p: Product = productSchema.parse(data)
        await transaction(async (client) => {
          await client.query(
            `INSERT INTO products(id,name,subtitle,description,price,features,plan,enabled,featured,upgrade,pricing_mode,pricing,price_currency,rounding_step) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,subtitle=excluded.subtitle,description=excluded.description,price=excluded.price,features=excluded.features,plan=excluded.plan,enabled=excluded.enabled,featured=excluded.featured,upgrade=excluded.upgrade,pricing_mode=excluded.pricing_mode,pricing=excluded.pricing,price_currency=excluded.price_currency,rounding_step=excluded.rounding_step`,
            [
              p.id,
              p.name,
              p.subtitle,
              p.description,
              p.price,
              JSON.stringify(p.features),
              p.plan,
              p.enabled,
              p.featured,
              p.upgrade,
              p.pricingMode,
              null,
              p.priceCurrency,
              p.roundingStep,
            ],
          )
          await audit(admin.email, '更新商品', p.id, client)
        })
        result = { saved: true }
      } else if (path === 'admin/settings' && method === 'POST') {
        const conf = z
          .object({
            rateBps: z.number().int().min(0).max(5000),
            settlementDays: z.number().int().min(0).max(180),
            minimumWithdrawal: z.number().int().min(100).max(100000000),
            firstOrderOnly: z.boolean(),
            supportEmail: z.union([z.email(), z.literal('')]),
            alipay: z.boolean(),
            wechat: z.boolean(),
            crypto: z.boolean(),
            fiatProvider: z.enum(['xorpay', 'epay', 'epay_v1', 'epay_v2']),
            emailProvider: z.enum(['smtp', 'resend']),
            paymentLimits: z.object({
              alipay: limitSchema,
              wechat: limitSchema,
              crypto: limitSchema,
            }),
            upgradePricing: z.object({
              fxMode: z.enum(['manual', 'auto']).default('auto'),
              fxRateBps: z.number().int().min(1).max(1000000),
              markupBps: z.number().int().min(0).max(100000),
              serviceFee: z.number().int().min(0).max(100000000),
              minimum: z.number().int().min(1).max(100000000),
              configured: z.boolean().default(false),
              targets: z
                .record(
                  z.enum(['plus', 'pro5', 'pro20', 'promax']),
                  z.object({
                    markupBps: z.number().int().min(0).max(100000),
                    serviceFee: z.number().int().min(0).max(100000000),
                    minimumProfit: z.number().int().min(1).max(100000000),
                    roundingStep: roundingSchema,
                  }),
                )
                .optional(),
            }),
          })
          .parse(data)
        await transaction(async (client) => {
          const current = (await client.query('SELECT body FROM settings WHERE id=1 FOR UPDATE'))
            .rows[0].body
          const version =
            current.epayVersion ?? (current.fiatProvider === 'epay_v2' ? 'epay_v2' : 'epay_v1')
          await client.query('UPDATE settings SET body=$1 WHERE id=1', [
            JSON.stringify({
              ...conf,
              epayVersion: version,
              fiatProvider: conf.fiatProvider === 'xorpay' ? 'xorpay' : version,
            }),
          ])
          await audit(admin.email, '更新返现与支付规则', 'settings', client)
        })
        result = { saved: true }
      } else if (path === 'admin/inventory' && method === 'POST') {
        const input = z
          .object({
            productId: z.string(),
            codes: z.array(z.string().trim().min(8).max(200)).min(1).max(500),
          })
          .parse(data)
        await transaction(async (client) => {
          for (const code of new Set(input.codes))
            await client.query(
              'INSERT INTO inventory(id,product_id,code,fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT(fingerprint) DO NOTHING',
              [id('i_'), input.productId, encrypt(code), hash(code)],
            )
          await audit(admin.email, '导入兑换库存', input.productId, client)
        })
        result = { saved: true }
      } else if (path === 'admin/users' && method === 'POST') {
        const input = z.object({ id: z.string(), disabled: z.boolean() }).parse(data)
        if (input.id === admin.id) throw new ApiError(400, '不能停用当前管理员')
        await transaction(async (client) => {
          await client.query("UPDATE users SET disabled=$2 WHERE id=$1 AND role<>'admin'", [
            input.id,
            input.disabled,
          ])
          if (input.disabled)
            await client.query('DELETE FROM auth_session WHERE "userId"=$1', [input.id])
          await audit(admin.email, input.disabled ? '停用用户' : '启用用户', input.id, client)
        })
        result = { saved: true }
      } else if (path === 'admin/withdrawals' && method === 'POST') {
        const input = z
          .object({
            id: z.string(),
            status: z.enum(['paid', 'rejected']),
            note: z.string().trim().min(3).max(300),
          })
          .parse(data)
        await transaction(async (client) => {
          const changed = await client.query(
            "UPDATE withdrawals SET status=$2,note=$3 WHERE id=$1 AND status='pending' RETURNING id",
            [input.id, input.status, input.note],
          )
          if (!changed.rowCount) throw new ApiError(409, '该提现已处理，请刷新')
          await audit(
            admin.email,
            input.status === 'paid' ? '登记提现打款' : '拒绝提现',
            input.id,
            client,
          )
        })
        result = { saved: true }
      } else if (path === 'admin/orders/retry' && method === 'POST') {
        const input = z.object({ id: z.string() }).parse(data)
        await transaction(async (client) => {
          const order = (
            await client.query(
              "SELECT id FROM orders WHERE id=$1 AND status='processing' FOR UPDATE",
              [input.id],
            )
          ).rows[0]
          if (!order) throw new ApiError(409, '只能重试仍在处理的订单')
          await client.query('UPDATE jobs SET done=false,run_at=now() WHERE order_id=$1', [
            input.id,
          ])
          await audit(admin.email, '请求重新同步订单', input.id, client)
        })
        result = { saved: true }
      } else throw new ApiError(404, '接口不存在')
    } else throw new ApiError(404, '接口不存在')
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}
export const GET = handle
export const POST = handle
