import { NextRequest } from 'next/server'
import { ApiError, demo } from '../../../../../../server/config'
import { bodyText, failure, guard, parseFlatCallbackJSON } from '../../../../../../server/http'
import { integration } from '../../../../../../server/integrations/config'
import {
  verifyReceipt,
  confirmGmpayReceipt,
  type Provider,
} from '../../../../../../server/integrations/payments'
import { acceptPayment } from '../../../../../../server/services'

export const runtime = 'nodejs'
function uniqueParams(params: URLSearchParams) {
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new ApiError(400, '重复的回调参数')
    result[key] = value
  }
  return result
}
async function handle(
  request: NextRequest,
  context: { params: Promise<{ provider: string; revision: string }> },
) {
  try {
    guard(request, true)
    if (demo) throw new ApiError(404, '演示环境不接收真实付款通知')
    const { provider, revision } = await context.params
    if (!['xorpay', 'gmpay', 'epay_v1', 'epay_v2'].includes(provider))
      throw new ApiError(404, '未知渠道')
    if (request.method === 'GET' && !provider.startsWith('epay'))
      throw new ApiError(405, '不支持此请求方式')
    let fields: Record<string, string>
    if (request.method === 'GET') fields = uniqueParams(request.nextUrl.searchParams)
    else {
      const text = await bodyText(request, 64_000)
      if (provider === 'gmpay') {
        fields = parseFlatCallbackJSON(text)
      } else fields = uniqueParams(new URLSearchParams(text))
    }
    const config = await integration(provider as Provider, revision)
    const receipt = verifyReceipt(provider as Provider, fields, config)
    if (provider === 'gmpay' && receipt.paid) await confirmGmpayReceipt(receipt, config)
    await acceptPayment(provider, revision, receipt)
    return new Response(provider.startsWith('epay') ? 'success' : 'ok', {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return failure(error)
  }
}
export const GET = handle
export const POST = handle
