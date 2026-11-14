import { ZenEngine } from '@gorules/zen-engine'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import limits from './risk/limits.json'
import decisions from './risk/decisions.json'
import { ApiError } from './config'

// Bundled, reviewed JDM documents only: no remote loader or client-supplied rules.
export const riskVersion = `zen-v1-${createHash('sha256')
  .update(JSON.stringify([limits, decisions]))
  .digest('hex')
  .slice(0, 16)}`
const engine = new ZenEngine()
const limitDecision = engine.createDecision(limits)
const riskDecision = engine.createDecision(decisions)
limitDecision.validate()
riskDecision.validate()

export const riskScenes = [
  'events',
  'quote',
  'order',
  'order-contact',
  'preflight',
  'session-update',
  'email',
  'fx-refresh',
  'inventory-import',
  'withdrawal-estimate',
  'withdrawal-fx-refresh',
  'withdrawal-request',
  'quote-target',
  'auth-default',
  'auth-opaque',
  'auth-otp',
  'auth-demo-mfa',
  'auth-demo-primary',
] as const
export type RiskScene = (typeof riskScenes)[number]
export const dimensionSchema = z.enum(['browser', 'user', 'email', 'target', 'ip', 'global'])
export type RiskSubjects = Partial<Record<z.infer<typeof dimensionSchema>, string>>
const modeSchema = z.enum(['enforce', 'observe'])
const actionSchema = z.enum(['allow', 'deny', 'challenge', 'review'])
const limitSchema = z.object({
  dimension: dimensionSchema,
  prefix: z.string().min(1),
  limit: z.number().int().positive(),
  seconds: z.number().int().positive(),
  mode: modeSchema,
  reason: z.string().min(1),
  required: z.boolean(),
})
export type RiskLimit = z.infer<typeof limitSchema>
const resultSchema = z.object({
  action: actionSchema,
  mode: modeSchema,
  reason: z.string(),
})
export type RiskDecision = z.infer<typeof resultSchema>
const countSchema = z.number().int().nonnegative()
const factsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rate'),
    count: countSchema,
    limit: z.number().int().positive(),
    mode: modeSchema,
    reason: z.string().min(1),
  }),
  z.object({ kind: z.literal('challenge'), required: z.boolean(), verified: z.boolean() }),
  z.object({
    kind: z.literal('referral'),
    self: z.boolean(),
    firstOrderOnly: z.boolean(),
    previous: z.boolean(),
  }),
  z.object({ kind: z.literal('order'), unpaidOrders: countSchema }),
  z.object({
    kind: z.literal('withdrawal'),
    sharedPayoutUsers: countSchema,
    accountAgeHours: z.number().nonnegative(),
  }),
])
export type RiskFacts = z.infer<typeof factsSchema>

export async function riskLimits(scene: RiskScene, demo: boolean): Promise<RiskLimit[]> {
  try {
    const { result } = await limitDecision.evaluate({ scene, demo })
    return z.array(limitSchema).min(1).parse(result)
  } catch {
    throw new ApiError(503, '安全检查暂不可用，请稍后重试')
  }
}

export async function decideRisk(facts: RiskFacts): Promise<RiskDecision> {
  try {
    const { result } = await riskDecision.evaluate(factsSchema.parse(facts))
    return resultSchema.parse(result)
  } catch {
    // Never silently turn a failed engine evaluation into an allow.
    throw new ApiError(503, '安全检查暂不可用，请稍后重试')
  }
}
