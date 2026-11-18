import type { NextRequest } from 'next/server'
import { ApiError, demo } from '../../../../server/config'
import { bodyBytes, failure, guard } from '../../../../server/http'
import { verifyAicdkEvent, wakeRedemptionPoll } from '../../../../server/aicdk-webhook'

export const runtime = 'nodejs'
export async function POST(request: NextRequest) {
  try {
    if (demo || process.env.AICDK_WEBHOOK_ENABLED !== 'true') throw new ApiError(404, '接口不存在')
    guard(request, true)
    const secret = process.env.AICDK_WEBHOOK_SECRET
    if (!secret) throw new ApiError(503, '未配置通知签名密钥')
    await wakeRedemptionPoll(
      verifyAicdkEvent(request.headers, await bodyBytes(request, 16_384), secret),
    )
    return new Response(null, { status: 204 })
  } catch (error) {
    return failure(error)
  }
}
