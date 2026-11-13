import { readFile } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { auth } from '../src/server/better-auth'
import { pool, transaction } from '../src/server/db'
import { defaultPaymentLimits } from '../src/pricing'
import { defaultReferralTiers } from '../src/referral'
import { defaultWithdrawalChannels, withdrawalChannels } from '../src/withdrawals'
import { migrateCredentialStorage } from '../src/server/credential-storage'

await transaction(async (client) => {
  await client.query(await readFile(new URL('../src/server/schema.sql', import.meta.url), 'utf8'))
  await migrateCredentialStorage(client)
  const products = [
    {
      id: 'plus',
      name: 'ChatGPT Plus',
      subtitle: '日常使用，轻松进阶',
      description: '适合日常问答、学习和创作。充值到你自己的账号。',
      price: 12900,
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
      price: 65900,
      features: ['适合高频工作需求', '账号适用性检查', '支持订单异常处理'],
      plan: 'pro5',
      featured: false,
      upgrade: false,
    },
    {
      id: 'upgrade',
      name: '升级至 ChatGPT Pro 200',
      subtitle: '让现有账号再进一步',
      description: '检查当前订阅状态和升级条件，再确认本次升级价格。',
      price: 59900,
      features: ['保留现有账号', '先检查再付款', '确认最终升级金额'],
      plan: 'pro20',
      featured: false,
      upgrade: true,
    },
  ]
  products.push(
    {
      id: 'go',
      name: 'ChatGPT Go',
      subtitle: '从轻量使用开始',
      description: '为自己的账号充值 Go。账号适用性以验证结果为准。',
      price: 4900,
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
      price: 132900,
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
      price: 332900,
      features: ['Pro 500 目标套餐', '付款前检查账号', '订单异常协助'],
      plan: 'promax',
      featured: false,
      upgrade: false,
    },
    ...[
      ['upgrade-plus', 'Plus', 'plus'],
      ['upgrade-pro100', 'Pro 100', 'pro5'],
      ['upgrade-pro500', 'Pro 500', 'promax'],
    ].map(([id, title, plan]) => ({
      id,
      name: `升级至 ChatGPT ${title}`,
      subtitle: '按当前订阅实时核价',
      description: `检查当前账号升级至 ${title} 的条件，确认最终报价后付款。`,
      price: 100,
      features: ['当前套餐适用性检查', '按本次预检金额报价', '报价确认后再付款'],
      plan,
      featured: false,
      upgrade: true,
    })),
  )
  for (const p of products)
    await client.query(
      'INSERT INTO products(id,name,subtitle,description,price,features,plan,featured,upgrade,pricing_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',
      [
        p.id,
        p.name,
        p.subtitle,
        p.description,
        p.price,
        JSON.stringify(p.features),
        p.plan,
        p.featured,
        p.upgrade,
        p.upgrade ? 'markup' : 'fixed',
      ],
    )
  await client.query(
    "UPDATE products SET name='升级至 ChatGPT Pro 200' WHERE id='upgrade' AND name='升级现有套餐'",
  )
  await client.query('INSERT INTO settings(id,body) VALUES(1,$1) ON CONFLICT DO NOTHING', [
    JSON.stringify({
      rateBps: 300,
      referralTiers: defaultReferralTiers,
      withdrawalChannels: defaultWithdrawalChannels,
      settlementDays: 7,
      minimumWithdrawal: 5000,
      firstOrderOnly: true,
      supportEmail: '',
      alipay: true,
      wechat: true,
      crypto: true,
      fiatProvider: 'xorpay',
      emailProvider: 'resend',
      paymentLimits: defaultPaymentLimits,
      upgradePricing: {
        fxMode: 'auto',
        fxRateBps: 70000,
        markupBps: 2500,
        serviceFee: 0,
        roundingStep: 100,
        minimum: 100,
      },
    }),
  ])
  await client.query(
    `UPDATE settings SET body=body||jsonb_build_object('rateBps',300,'referralTiers',$1::jsonb)
     WHERE NOT(body ? 'referralTiers')`,
    [JSON.stringify(defaultReferralTiers)],
  )
  const previousSettings = (await client.query('SELECT body FROM settings WHERE id=1 FOR UPDATE'))
    .rows[0].body
  await client.query(
    `UPDATE settings SET body=jsonb_set(body,'{withdrawalChannels}',$1::jsonb)
     WHERE id=1 AND body->'withdrawalChannels' IS DISTINCT FROM $1::jsonb`,
    [JSON.stringify(withdrawalChannels(previousSettings))],
  )
  await client.query(
    `UPDATE settings SET body=body||'{"emailProvider":"resend"}'::jsonb WHERE NOT(body ? 'emailProvider')`,
  )
  await client.query(
    `UPDATE settings SET body=jsonb_build_object(
    'paymentLimits', $1::jsonb,
    'upgradePricing', '{"fxMode":"auto","fxRateBps":70000,"markupBps":2500,"serviceFee":0,"minimum":100,"roundingStep":100}'::jsonb
  ) || body WHERE id=1`,
    [JSON.stringify(defaultPaymentLimits)],
  )
  await client.query(`UPDATE settings SET body=jsonb_set(body,'{upgradePricing}',
    jsonb_build_object('configured',false,'fxMode','auto','roundingStep',100,'targets',jsonb_build_object(
      'plus',jsonb_build_object('markupBps',2500,'serviceFee',0,'minimumProfit',1000,'roundingStep',100),
      'pro5',jsonb_build_object('markupBps',2500,'serviceFee',0,'minimumProfit',1000,'roundingStep',100),
      'pro20',jsonb_build_object('markupBps',2500,'serviceFee',0,'minimumProfit',1000,'roundingStep',100),
      'promax',jsonb_build_object('markupBps',2500,'serviceFee',0,'minimumProfit',1000,'roundingStep',100)
    )) || (body->'upgradePricing')) WHERE id=1`)
  for (const role of [
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
  ])
    await client.query(
      'INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [role.id, role.name, JSON.stringify(role.permissions)],
    )
})
await (await getMigrations(auth.options)).runMigrations()
await pool.query(
  await readFile(new URL('../src/server/auth-invariants.sql', import.meta.url), 'utf8'),
)
console.log('Database schema ready. Product prices are samples; configure them before live use.')
await pool.end()
