import { db, transaction, type DbClient } from '../src/server/db'
import { jsonInput, settingsData } from '../src/server/data'
import { id } from '../src/server/crypto'
import { defaultPlanPrices } from '../src/pricing'
import { defaultReferralTiers } from '../src/referral'
import { referralTiersSchema } from '../src/server/referral-policy'

// Explicit rollout for existing databases; ordinary seeding stays non-destructive.
export async function updateCommercialPolicy(client: DbClient) {
  await client.$queryRaw`SELECT id FROM settings WHERE id=1 FOR UPDATE`
  const record = await client.setting.findUniqueOrThrow({ where: { id: 1 } })
  const settings = settingsData(record.body)
  const tiers = referralTiersSchema.parse(settings.referralTiers ?? defaultReferralTiers)
  // This rollout only targets the original ladder; custom configurations keep their rates.
  const usesDefaultLadder =
    tiers.length === defaultReferralTiers.length &&
    tiers.every(
      (tier, index) =>
        tier.id === defaultReferralTiers[index].id &&
        tier.minimumInvites === defaultReferralTiers[index].minimumInvites,
    )
  const referralTiers = usesDefaultLadder
    ? tiers.map((tier, index) => ({ ...tier, rateBps: defaultReferralTiers[index].rateBps }))
    : tiers
  const productsBefore = await client.product.findMany({
    where: { upgrade: false, plan: { in: Object.keys(defaultPlanPrices) } },
    select: { id: true, plan: true, price: true, priceCurrency: true },
  })
  for (const [plan, price] of Object.entries(defaultPlanPrices)) {
    await client.product.updateMany({
      where: { upgrade: false, plan },
      data: { price, priceCurrency: 'CNY', pricingMode: 'fixed' },
    })
  }
  await client.setting.update({
    where: { id: 1 },
    data: {
      body: jsonInput({
        ...settings,
        rateBps: referralTiers[0].rateBps,
        referralTiers,
      }),
    },
  })
  await client.audit.create({
    data: {
      id: id('audit_'),
      actor: 'script:update-commercial-policy',
      action: JSON.stringify({
        policy: '2026-11-15',
        productsBefore,
        prices: defaultPlanPrices,
        previousReferralRates: tiers.map((tier) => tier.rateBps),
        referralRates: referralTiers.map((tier) => tier.rateBps),
      }),
      target: 'commercial-policy',
    },
  })
}

if (import.meta.main) {
  try {
    await transaction(updateCommercialPolicy)
    console.log(
      'Updated recharge prices and default referral rates (3/4/5/6%). Existing order and quote snapshots preserved.',
    )
  } finally {
    await db.$disconnect()
  }
}
