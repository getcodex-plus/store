import { createHmac } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
vi.hoisted(() => {
  process.env.APP_MODE = 'live'
  process.env.APP_URL = 'https://store.example'
})
const updateMany = vi.hoisted(() => vi.fn())
vi.mock(import('./db'), async (original) => {
  const actual = await original()
  return { ...actual, db: { job: { updateMany } } as unknown as typeof actual.db }
})
import { POST } from '../app/api/aicdk/webhook/route'

const secret = 'fixture-webhook-signature'
const content = JSON.stringify({
  event_id: 'evt_1',
  type: 'redemption.completed',
  data: { id: 'remote_1', version: 3 },
})
function request(body = content, signed = body, age = 0, eventId = 'evt_1') {
  const timestamp = String(Math.floor(Date.now() / 1000) - age)
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${eventId}\n${signed}`)
    .digest('hex')
  return new NextRequest('https://store.example/api/aicdk/webhook', {
    method: 'POST',
    body,
    headers: {
      'X-AICDK-Timestamp': timestamp,
      'X-AICDK-Event-ID': eventId,
      'X-AICDK-Signature': `v1=${signature}`,
    },
  })
}
beforeEach(() => {
  vi.stubEnv('AICDK_WEBHOOK_ENABLED', undefined)
  vi.stubEnv('AICDK_WEBHOOK_SECRET', secret)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
it('is off by default, even with a valid secret and signature', async () => {
  expect((await POST(request())).status).toBe(404)
  expect(updateMany).not.toHaveBeenCalled()
})
it('only wakes the existing poll; never accepts a callback as proof of completion', async () => {
  vi.stubEnv('AICDK_WEBHOOK_ENABLED', 'true')
  expect((await POST(request())).status).toBe(204)
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      done: false,
      runAt: { gt: expect.any(Date) },
      order: { status: 'processing', redemptionId: 'remote_1', redemptionVersion: { lt: 3 } },
    },
    data: { runAt: expect.any(Date) },
  })
})
it('rejects tampered bytes, stale timestamps, mismatched events and missing signing configuration', async () => {
  vi.stubEnv('AICDK_WEBHOOK_ENABLED', 'true')
  expect((await POST(request(content + ' ', content))).status).toBe(401)
  expect((await POST(request(content, content, 305))).status).toBe(401)
  expect((await POST(request(content, content, 0, 'other'))).status).toBe(400)
  vi.stubEnv('AICDK_WEBHOOK_SECRET', '')
  expect((await POST(request())).status).toBe(503)
  expect(updateMany).not.toHaveBeenCalled()
})
