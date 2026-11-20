import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { tawkSettingsSchema } from '../../../tawk'
import { brandLogoSchema, brandNameSchema, normalizeBrandLogo } from '../../../server/brand-logo'
import { bodyText, failure, guard } from '../../../server/http'
import { ApiError, demo } from '../../../server/config'
import { browserDigest, currentUser, requireUser, requireRecent } from '../../../server/auth'
import {
  accessibleOrder,
  cancelOrder,
  account,
  adminData,
  audit,
  completeOrder,
  confirmSession,
  newOrder,
  paymentInfo,
  products,
  quote,
  settings,
  withdraw,
  acceptPayment,
  refundFailedOrder,
  reviewWithdrawal,
  withdrawalPayoutEstimate,
} from '../../../server/services'
import { db, Prisma, transaction } from '../../../server/db'
import { orderView, settingsData, jsonInput } from '../../../server/data'
import { databaseNow, lockRow, lockSettings } from '../../../server/database-sql'
import { normalizeDemoSession } from '../../../lib'
import { requestExchangeRefresh } from '../../../server/exchange-rates'
import { decrypt } from '../../../server/crypto'
import { importInventory } from '../../../server/credential-storage'
import {
  changeInventory,
  inventoryBatches,
  inventoryChangeSchema,
  inventoryList,
  inventoryQuerySchema,
} from '../../../server/inventory'
import { integrationSchema, saveIntegration } from '../../../server/integrations/config'
import {
  procurementOverview,
  supplierCatalog,
  saveStockMapping,
  removeStockMapping,
  queueStockPurchase,
  resyncPaidPurchase,
} from '../../../server/procurement'
import type { Product } from '../../../types'
import { authorize, mayGrant, permissions, type Permission } from '../../../server/rbac'
import { turnstilePublic } from '../../../server/turnstile'
import { checkRiskChallenge, checkRiskRate } from '../../../server/risk'
import { clientIP } from '../../../server/client-ip'
import { securityStatus } from '../../../server/security'
import { funnelSchema, sourceSchema } from '../../../funnel'
import { recordView } from '../../../server/funnel'
import { referralTiersSchema, withdrawalChannelsSchema } from '../../../server/referral-policy'
import { defaultReferralTiers } from '../../../referral'
import { withdrawalChannels } from '../../../withdrawals'
import { updateAdminUser } from '../../../server/admin-users'
import { adminQuerySchema } from '../../../server/admin-query'
import { accountHistory, accountHistoryQuery } from '../../../server/account-history'
import { resolveOrder } from '../../../server/order-resolution'
import { refillOrder } from '../../../server/order-refill'
import { releaseOrderInventory } from '../../../server/order-inventory'
import { previewCoupon, saveAdminCoupon } from '../../../server/coupons'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const emailSchema = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase().trim())
const roundingSchema = z
  .union([z.literal(1), z.literal(10), z.literal(100), z.literal(1000)])
  .default(100)
const productSchema = z.object({
  id: z.string().regex(/^[a-z\d_-]{1,64}$/),
  name: z.string().min(1).max(80),
  subtitle: z.string().max(100),
  description: z.string().max(500),
  price: z.number().int().min(1).max(100000000),
  features: z.array(z.string().min(1).max(100)).min(1).max(8),
  plan: z.enum(['go', 'plus', 'pro5', 'pro20', 'promax']),
  enabled: z.boolean(),
  featured: z.boolean(),
  upgrade: z.literal(false).default(false),
  pricingMode: z.literal('fixed').default('fixed'),
  priceCurrency: z.enum(['CNY', 'USD']).default('CNY'),
  roundingStep: roundingSchema,
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
    const data =
      request.method === 'GET'
        ? {}
        : JSON.parse((await bodyText(request, path === 'events' ? 1024 : 110_000)) || '{}')
    const method = request.method
    let result: unknown
    if (path === 'bootstrap' && method === 'GET') {
      await browserDigest()
      const [user, catalog, conf] = await Promise.all([currentUser(), products(), settings()])
      const {
        brandLogo: _logo,
        upgradePricing: _pricing,
        manualInventoryRelease: _release,
        ...publicSettings
      } = conf
      result = {
        mode: demo ? 'demo' : 'live',
        user,
        products: catalog,
        settings: publicSettings,
        turnstile: await turnstilePublic(),
      }
    } else if (path === 'events' && method === 'POST') {
      const input = funnelSchema.parse(data)
      if (request.headers.get('dnt') !== '1' && request.headers.get('sec-gpc') !== '1') {
        const browser = await browserDigest()
        await checkRiskRate('events', { browser })
        await recordView(browser, input.event, input.productId, input.source)
      }
      result = { recorded: true }
    } else if (path === 'demo/code' && method === 'POST' && demo) {
      const { email } = z.object({ email: emailSchema }).parse(data)
      const record = await db.demoMailbox.findFirst({
        where: {
          browserDigest: await browserDigest(),
          email,
          expiresAt: { gt: await databaseNow() },
        },
        select: { code: true },
      })
      result = { demoCode: record ? decrypt(record.code, 'demo-email') : null }
    } else if (path === 'security' && method === 'GET')
      result = await securityStatus(await requireUser())
    else if (path === 'quotes' && method === 'POST') {
      await checkRiskChallenge('purchase', data.turnstileToken)
      const input = z
        .object({
          productId: z.string().max(64),
          session: z.string().min(1).max(100000),
          source: sourceSchema.default('direct'),
          analytics: z.boolean().default(false),
        })
        .parse(data)
      const browser = await browserDigest()
      await checkRiskRate('quote', {
        browser,
        user: (await currentUser())?.id,
        ip: clientIP(request.headers),
      })
      let text = input.session
      if (demo) {
        try {
          text = normalizeDemoSession(text)
        } catch (error) {
          throw new ApiError(400, (error as Error).message)
        }
      }
      result = await quote(input.productId, text, browser, {
        source: input.source,
        analytics:
          input.analytics &&
          request.headers.get('dnt') !== '1' &&
          request.headers.get('sec-gpc') !== '1',
      })
    } else if (path === 'coupons/preview' && method === 'POST') {
      const input = z
        .object({
          code: z.string().min(1).max(64),
          quoteId: z.string().max(64).optional(),
        })
        .parse(data)
      const browser = await browserDigest()
      await checkRiskRate('coupon-preview', { browser, ip: clientIP(request.headers) })
      const [user, catalog] = await Promise.all([currentUser(), products()])
      result = await previewCoupon(input, user, browser, catalog)
    } else if (path === 'orders' && method === 'POST') {
      await checkRiskChallenge('purchase', data.turnstileToken)
      const input = z
        .object({
          quoteId: z.string().optional(),
          session: z.string().max(100000).optional(),
          amount: z.number().int().min(100).max(1000000).optional(),
          channel: z.enum(['alipay', 'wechat', 'crypto', 'balance']),
          requestKey: z.string().min(16).max(128),
          contactEmail: emailSchema.optional(),
          balanceAmount: z.number().int().min(0).max(100000000).optional(),
          referralCode: z
            .string()
            .regex(/^[a-z\d]{10,12}$/)
            .optional(),
          couponCode: z.string().max(64).optional(),
        })
        .refine((v) => Boolean(v.quoteId) !== Boolean(v.amount), {
          message: '请选择商品订单或钱包充值',
        })
        .parse(data)
      const user = await currentUser()
      const browser = await browserDigest()
      await checkRiskRate('order', { browser, user: user?.id, ip: clientIP(request.headers) })
      if (!demo && input.quoteId) await checkRiskRate('preflight', {})
      if (input.contactEmail) await checkRiskRate('order-contact', { email: input.contactEmail })
      result = await newOrder(
        user,
        browser,
        {
          ...input,
          session: demo && input.session ? normalizeDemoSession(input.session) : input.session,
        },
        // Keep the full address for the order snapshot, not the /64 rate-limit identity.
        clientIP(request.headers, { ipv6Subnet: 128 }),
      )
    } else if (/^orders\/[^/]+$/.test(path) && method === 'GET') {
      const order = await accessibleOrder(
        await currentUser(),
        await browserDigest(),
        path.split('/')[1],
      )
      result = orderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
    } else if (/^orders\/[^/]+\/cancel$/.test(path) && method === 'POST') {
      result = await cancelOrder(await currentUser(), await browserDigest(), path.split('/')[1])
    } else if (/^orders\/[^/]+\/pay$/.test(path) && method === 'POST') {
      const user = await currentUser()
      result = await paymentInfo(
        user,
        path.split('/')[1],
        clientIP(request.headers) ?? '',
        await browserDigest(),
      )
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
    } else if (/^orders\/[^/]+\/refill$/.test(path) && method === 'POST') {
      const user = await currentUser()
      const browser = await browserDigest()
      const orderId = path.split('/')[1]
      await checkRiskRate('session-update', {
        browser,
        user: user?.id,
        ip: clientIP(request.headers),
      })
      const order = await accessibleOrder(user, browser, orderId)
      if (order.canRefill) await checkRiskRate('preflight', {})
      result = await refillOrder(user, browser, orderId, data)
    } else if (/^orders\/[^/]+\/session$/.test(path) && method === 'POST') {
      const input = z.object({ session: z.string().max(100000) }).parse(data)
      await checkRiskRate('session-update', {
        browser: await browserDigest(),
        user: (await currentUser())?.id,
        ip: clientIP(request.headers),
      })
      result = await confirmSession(
        await currentUser(),
        path.split('/')[1],
        demo ? normalizeDemoSession(input.session) : input.session,
        await browserDigest(),
      )
    } else if (path === 'account/history' && method === 'GET') {
      const user = await requireUser()
      result = await accountHistory(
        user.id,
        accountHistoryQuery.parse(Object.fromEntries(request.nextUrl.searchParams)),
      )
    } else if (path === 'account' && method === 'GET') result = await account(await requireUser())
    else if (path === 'wallet/withdraw' && method === 'POST') {
      const user = await requireUser()
      await requireRecent(user)
      await checkRiskRate('withdrawal-request', {
        user: user.id,
        ip: clientIP(request.headers),
      })
      result = { submitted: true, withdrawal: await withdraw(user, data) }
    } else if (path.startsWith('admin')) {
      const admin = await requireUser(true)
      const permissionMap: Record<string, Permission> = {
        'admin/integrations': 'integrations:write',
        'admin/procurement/mapping': 'integrations:write',
        'admin/procurement/unmap': 'integrations:write',
        'admin/procurement/orders': 'integrations:write',
        'admin/procurement/resync': 'integrations:write',
        'admin/products': 'products:write',
        'admin/coupons': 'coupons:write',
        'admin/inventory': 'products:write',
        'admin/inventory/change': 'products:write',
        'admin/settings': 'settings:write',
        'admin/exchange-rates/refresh': 'settings:write',
        'admin/users': 'users:write',
        'admin/withdrawals': 'withdrawals:write',
        'admin/withdrawals/estimate': 'withdrawals:write',
        'admin/orders/retry': 'orders:write',
        'admin/orders/refund': 'orders:write',
        'admin/orders/resolve': 'orders:write',
        'admin/orders/release-inventory': 'orders:write',
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
      if (path === 'admin/procurement' || path.startsWith('admin/procurement/')) {
        authorize(admin, method === 'POST' ? 'products:write' : 'products:read')
        authorize(admin, 'integrations:read')
      }
      if (path === 'admin' && method === 'GET')
        result = await adminData(
          admin,
          adminQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams)),
        )
      else if (path === 'admin/procurement' && method === 'GET')
        result = await procurementOverview(
          Object.fromEntries(request.nextUrl.searchParams),
        )
      else if (path === 'admin/procurement/catalog' && method === 'GET')
        result = await supplierCatalog(
          z.coerce
            .number()
            .int()
            .min(1)
            .max(10000)
            .parse(request.nextUrl.searchParams.get('page') ?? 1),
        )
      else if (path === 'admin/procurement/mapping' && method === 'POST')
        result = await saveStockMapping(data, admin.email)
      else if (path === 'admin/procurement/unmap' && method === 'POST')
        result = await removeStockMapping(data, admin.email)
      else if (path === 'admin/procurement/orders' && method === 'POST')
        result = await queueStockPurchase(data, admin.email)
      else if (path === 'admin/procurement/resync' && method === 'POST')
        result = await resyncPaidPurchase(data, admin.email)
      else if (path === 'admin/coupons' && method === 'POST')
        result = await saveAdminCoupon(admin.email, data, audit)
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
          await lockRow(client, 'roles', input.id)
          const existing = await client.role.findUnique({ where: { id: input.id } })
          if (existing?.protected) throw new ApiError(403, '内置角色不可修改')
          if (existing) mayGrant(admin, z.array(z.string()).parse(existing.permissions))
          await client.role.upsert({
            where: { id: input.id },
            create: input,
            update: { name: input.name, permissions: input.permissions },
          })
          await audit(admin.email, '更新角色', input.id, client)
        })
        result = { saved: true }
      } else if (path === 'admin/user-roles' && method === 'POST') {
        const input = z
          .object({ userId: z.string(), roleIds: z.array(z.string()).max(20) })
          .parse(data)
        await transaction(async (client) => {
          await lockRow(client, 'users', input.userId)
          const user = await client.user.findUnique({ where: { id: input.userId } })
          if (!user || user.role === 'admin') throw new ApiError(403, '内置管理员角色受保护')
          const roles = await client.role.findMany({
            where: { id: { in: input.roleIds } },
            select: { permissions: true },
          })
          if (roles.length !== new Set(input.roleIds).size) throw new ApiError(400, '角色不存在')
          const previous = await client.userRole.findMany({
            where: { userId: input.userId },
            select: { role: { select: { permissions: true } } },
          })
          mayGrant(
            admin,
            [...roles, ...previous.map((r) => r.role)].flatMap((r) =>
              z.array(z.string()).parse(r.permissions),
            ),
          )
          await client.userRole.deleteMany({ where: { userId: input.userId } })
          await client.userRole.createMany({
            data: [...new Set(input.roleIds)].map((roleId) => ({ userId: input.userId, roleId })),
          })
          await client.authSession.deleteMany({ where: { userId: input.userId } })
          await audit(admin.email, '分配用户角色', input.userId, client)
        })
        result = { saved: true }
      } else if (path === 'admin/orders/release-inventory' && method === 'POST') {
        await requireRecent(admin)
        result = await releaseOrderInventory(data, admin.email)
      } else if (path === 'admin/orders/resolve' && method === 'POST') {
        await requireRecent(admin)
        result = await resolveOrder(z.object({ id: z.string() }).parse(data).id, admin.email, data)
      } else if (path === 'admin/orders/refund' && method === 'POST') {
        await requireRecent(admin)
        result = await refundFailedOrder(
          z.object({ id: z.string() }).parse(data).id,
          admin.email,
          data,
        )
      } else if (path === 'admin/exchange-rates/refresh' && method === 'POST') {
        await checkRiskRate('fx-refresh', { user: admin.id })
        await requestExchangeRefresh()
        await transaction((client) => audit(admin.email, '请求刷新汇率', 'USD_CNY', client))
        result = { queued: true }
      } else if (path === 'admin/products' && method === 'POST') {
        const p: Product = productSchema.parse(data)
        await transaction(async (client) => {
          if ((await client.product.findUnique({ where: { id: p.id } }))?.upgrade)
            throw new ApiError(409, '历史升级商品不能重新上架')
          const record = { ...p, pricing: Prisma.DbNull }
          await client.product.upsert({ where: { id: p.id }, create: record, update: record })
          await audit(admin.email, '更新商品', p.id, client)
        })
        result = { saved: true }
      } else if (path === 'admin/settings' && method === 'POST') {
        const conf = z
          .object({
            brandName: brandNameSchema.optional(),
            manualInventoryRelease: z.boolean().optional(),
            brandLogo: brandLogoSchema.optional(),
            rateBps: z.number().int().min(0).max(5000),
            referralTiers: referralTiersSchema.optional(),
            withdrawalChannels: withdrawalChannelsSchema.optional(),
            settlementDays: z.number().int().min(0).max(180),
            firstOrderOnly: z.boolean(),
            supportEmail: z.union([z.email(), z.literal('')]),
            tawk: tawkSettingsSchema.optional(),
            sessionGuideUrl: z
              .union([
                z.literal(''),
                z
                  .url()
                  .max(2048)
                  .refine(
                    (value) => {
                      const url = new URL(value)
                      return (
                        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
                      )
                    },
                    { message: '操作指引必须是无登录凭据的 HTTP 或 HTTPS 地址' },
                  ),
              ])
              .default(''),
            alipay: z.boolean(),
            wechat: z.boolean(),
            crypto: z.boolean(),
            fiatProvider: z.enum(['xorpay', 'epay', 'epay_v1', 'epay_v2']),
            emailProvider: z.enum(['smtp', 'resend', 'sendflare']),
            paymentLimits: z.object({
              alipay: limitSchema,
              wechat: limitSchema,
              crypto: limitSchema,
            }),
          })
          .parse(data)
        const brandLogo =
          conf.brandLogo === undefined ? undefined : await normalizeBrandLogo(conf.brandLogo)
        await transaction(async (client) => {
          await lockSettings(client)
          const current = settingsData(
            (await client.setting.findUniqueOrThrow({ where: { id: 1 } })).body,
          )
          const version =
            current.epayVersion ?? (current.fiatProvider === 'epay_v2' ? 'epay_v2' : 'epay_v1')
          const referralTiers = conf.referralTiers ?? current.referralTiers ?? defaultReferralTiers
          await client.setting.update({
            where: { id: 1 },
            data: {
              body: jsonInput({
                ...current,
                ...conf,
                brandName: conf.brandName ?? current.brandName,
                brandLogo: brandLogo ?? current.brandLogo,
                tawk: conf.tawk ?? current.tawk,
                referralTiers,
                withdrawalChannels: conf.withdrawalChannels ?? withdrawalChannels(current),
                rateBps: referralTiers[0].rateBps,
                epayVersion: version,
                fiatProvider: conf.fiatProvider === 'xorpay' ? 'xorpay' : version,
              }),
            },
          })
          await audit(admin.email, '更新网站设置', 'settings', client)
        })
        result = { saved: true }
      } else if (path === 'admin/inventory/batches' && method === 'GET') {
        authorize(admin, 'products:read')
        result = await inventoryBatches(
          inventoryQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams)),
        )
      } else if (path === 'admin/inventory' && method === 'GET') {
        authorize(admin, 'products:read')
        result = await inventoryList(
          inventoryQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams)),
          admin.permissions.includes('orders:read') || admin.permissions.includes('orders:write'),
        )
      } else if (path === 'admin/inventory/change' && method === 'POST') {
        await requireRecent(admin)
        await checkRiskRate('inventory-import', { user: admin.id })
        result = await changeInventory(inventoryChangeSchema.parse(data), admin.email)
      } else if (path === 'admin/inventory' && method === 'POST') {
        await requireRecent(admin)
        await checkRiskRate('inventory-import', { user: admin.id })
        const input = z
          .object({
            productId: z.string().regex(/^[a-z\d_-]{1,64}$/),
            codes: z.array(z.string().trim().min(8).max(200)).min(1).max(500),
            batchName: z.string().trim().max(80).default(''),
            discountCountry: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z]{2}$/)
              .nullable()
              .optional(),
            note: z.string().trim().max(300).default(''),
            enabled: z.boolean().default(true),
          })
          .parse(data)
        result = await importInventory(input.productId, input.codes, admin.email, input)
      } else if (path === 'admin/users' && method === 'POST') {
        result = await updateAdminUser(admin, data)
      } else if (path === 'admin/withdrawals/estimate' && method === 'POST') {
        const input = z
          .object({ id: z.string().min(1), refresh: z.boolean().default(false) })
          .parse(data)
        await checkRiskRate('withdrawal-estimate', { user: admin.id })
        if (input.refresh) await checkRiskRate('withdrawal-fx-refresh', { user: admin.id })
        result = await withdrawalPayoutEstimate(input.id, input.refresh)
      } else if (path === 'admin/withdrawals' && method === 'POST') {
        result = await reviewWithdrawal(admin, data)
      } else if (path === 'admin/orders/retry' && method === 'POST') {
        const input = z.object({ id: z.string() }).parse(data)
        await transaction(async (client) => {
          await lockRow(client, 'orders', input.id)
          const order = await client.order.findFirst({
            where: { id: input.id, status: 'processing' },
            select: { id: true },
          })
          if (!order) throw new ApiError(409, '只能重试仍在处理的订单')
          await client.job.updateMany({
            where: { orderId: input.id },
            data: { done: false, runAt: await databaseNow(client) },
          })
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
