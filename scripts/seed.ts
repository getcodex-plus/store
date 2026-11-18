import { db, transaction, type DbClient } from '../src/server/db'
import { jsonInput } from '../src/server/data'
import { defaultPaymentLimits, defaultPlanPrices } from '../src/pricing'
import { defaultReferralTiers } from '../src/referral'
import { defaultWithdrawalChannels } from '../src/withdrawals'

// Explicit, non-destructive initialization. Existing operator settings and prices win.
export async function seedDatabase(client: DbClient) {
  const products = [
    {
      id: 'plus',
      name: 'ChatGPT Plus',
      subtitle: '日常使用，轻松进阶',
      description: '适合日常问答、学习和创作。充值到你自己的账号。',
      price: defaultPlanPrices.plus,
      features: ['充值到自己的账号', '付款前检查账号', '订单进度随时可查'],
      plan: 'plus',
      featured: true,
      upgrade: false,
    },
    {
      id: 'pro100',
      name: 'ChatGPT Pro 100',
      subtitle: '给高频使用的你',
      description: '为更高强度的工作需求准备。购买前确认账号适用性。',
      price: defaultPlanPrices.pro5,
      features: ['适合高频工作需求', '账号适用性检查', '支持订单异常处理'],
      plan: 'pro5',
      featured: false,
      upgrade: false,
    },
    {
      id: 'go',
      name: 'ChatGPT Go',
      subtitle: '从轻量使用开始',
      description: '为自己的账号充值 Go。账号适用性以验证结果为准。',
      price: defaultPlanPrices.go,
      features: ['自己的账号', '付款前检查账号', '订单进度可查'],
      plan: 'go',
      featured: false,
      upgrade: false,
    },
    {
      id: 'pro200',
      name: 'ChatGPT Pro 200',
      subtitle: '面向更高强度的工作',
      description: '充值 Pro 200，付款前确认账号和本次服务。',
      price: defaultPlanPrices.pro20,
      features: ['Pro 200 目标套餐', '付款前检查账号', '订单异常协助'],
      plan: 'pro20',
      featured: false,
      upgrade: false,
    },
    {
      id: 'pro500',
      name: 'ChatGPT Pro 500',
      subtitle: '为密集工作需求准备',
      description: '充值 Pro 500，付款前确认账号和本次服务。',
      price: defaultPlanPrices.promax,
      features: ['Pro 500 目标套餐', '付款前检查账号', '订单异常协助'],
      plan: 'promax',
      featured: false,
      upgrade: false,
    },
  ]

  await client.product.createMany({
    data: products,
    skipDuplicates: true,
  })
  await client.setting.createMany({
    data: [
      {
        id: 1,
        body: jsonInput({
          rateBps: defaultReferralTiers[0].rateBps,
          referralTiers: defaultReferralTiers,
          withdrawalChannels: defaultWithdrawalChannels,
          settlementDays: 7,
          firstOrderOnly: false,
          supportEmail: '',
          alipay: true,
          wechat: true,
          crypto: true,
          fiatProvider: 'xorpay',
          emailProvider: 'resend',
          paymentLimits: defaultPaymentLimits,
        }),
      },
    ],
    skipDuplicates: true,
  })
  await client.role.createMany({
    data: [
      { id: 'support', name: '客服', permissions: ['admin:access', 'orders:read', 'users:read'] },
      {
        id: 'operator',
        name: '运营',
        permissions: [
          'admin:access',
          'orders:read',
          'orders:write',
          'products:read',
          'products:write',
          'coupons:read',
          'coupons:write',
          'referral:read',
          'users:read',
        ],
      },
      {
        id: 'finance',
        name: '财务',
        permissions: [
          'admin:access',
          'wallet:read',
          'withdrawals:read',
          'withdrawals:write',
          'referral:read',
          'audit:read',
        ],
      },
    ],
    skipDuplicates: true,
  })
  await client.exchangeRate.createMany({
    data: [{ id: 'USD_CNY' }, { id: 'USDT_CNY' }],
    skipDuplicates: true,
  })
}

if (import.meta.main) {
  try {
    await transaction(seedDatabase)
    console.log('Missing initial records created; existing prices and settings preserved.')
  } finally {
    await db.$disconnect()
  }
}
