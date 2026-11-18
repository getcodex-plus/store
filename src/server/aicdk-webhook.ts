import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from './db'
import { ApiError } from './config'

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const envelope = z.object({
  event_id: identifier,
  type: z.string().regex(/^redemption\.[a-z_]+$/),
  data: z.object({ id: identifier, version: z.number().int().min(0).max(2_147_483_647) }),
})

export function verifyAicdkEvent(headers: Headers, raw: Buffer, secret: string) {
  const timestamp = headers.get('X-AICDK-Timestamp') ?? ''
  const eventId = headers.get('X-AICDK-Event-ID') ?? ''
  const signature = headers.get('X-AICDK-Signature') ?? ''
  if (
    !secret ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !identifier.safeParse(eventId).success ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    throw new ApiError(401, '通知签名无效')
  const mac = createHmac('sha256', secret).update(`${timestamp}\n${eventId}\n`).update(raw).digest()
  if (!timingSafeEqual(mac, Buffer.from(signature.slice(3), 'hex')))
    throw new ApiError(401, '通知签名无效')
  const event = envelope.parse(JSON.parse(raw.toString('utf8')))
  if (event.event_id !== eventId) throw new ApiError(400, '通知标识不一致')
  return event.data
}

export async function wakeRedemptionPoll(event: { id: string; version: number }) {
  const now = new Date()
  await db.job.updateMany({
    where: {
      done: false,
      runAt: { gt: now },
      order: {
        status: 'processing',
        redemptionId: event.id,
        redemptionVersion: { lt: event.version },
      },
    },
    data: { runAt: now },
  })
}
