import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { ApiError, appUrl, demo, validateRuntime } from './config'
import { UpstreamError } from './integrations/aicdk'
import { safeUpstreamError } from './safe-errors'

export const privateResponseHeaders = { 'Cache-Control': 'private, no-store, max-age=0' }

export async function bodyBytes(request: Pick<Request, 'body' | 'headers'>, max = 110_000) {
  if (Number(request.headers.get('content-length') || 0) > max) throw new ApiError(413, '请求过大')
  const reader = request.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  let length = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.length
    if (length > max) {
      await reader.cancel()
      throw new ApiError(413, '请求过大')
    }
    chunks.push(part.value)
  }
  return Buffer.concat(chunks)
}
export async function bodyText(request: Pick<Request, 'body' | 'headers'>, max = 110_000) {
  return (await bodyBytes(request, max)).toString('utf8')
}
export function guard(request: NextRequest, callback = false) {
  validateRuntime()
  const host = request.headers.get('host')?.split(':')[0]
  if (demo && !['localhost', '127.0.0.1'].includes(host || ''))
    throw new ApiError(403, '演示环境仅限本地访问')
  if (!callback && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin')
    if (origin !== appUrl || request.headers.get('x-getgpt-request') !== '1')
      throw new ApiError(403, '请求来源无效')
  }
}
export function failure(error: unknown) {
  if (error instanceof ApiError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: privateResponseHeaders },
    )
  if (error instanceof ZodError)
    return NextResponse.json(
      { error: '输入格式不正确，请检查填写内容' },
      { status: 400, headers: privateResponseHeaders },
    )
  if (error instanceof SyntaxError)
    return NextResponse.json(
      { error: '请求格式不正确' },
      { status: 400, headers: privateResponseHeaders },
    )
  if (error instanceof UpstreamError) {
    const safe = safeUpstreamError(error)
    return NextResponse.json(
      { error: '账号服务暂未完成验证，请稍后重试', code: safe.code },
      {
        status: error.status === 429 ? 429 : 503,
        headers: { ...privateResponseHeaders, 'Retry-After': String(safe.retryAfter) },
      },
    )
  }
  // Avoid logging request bodies, SQL parameters, credentials or provider payloads.
  console.error('Request failed')
  return NextResponse.json(
    { error: '暂时无法完成操作，请稍后重试' },
    { status: 500, headers: privateResponseHeaders },
  )
}
// Payment callbacks are flat objects. Reject duplicate JSON keys before JSON.parse
// can silently discard one, including equivalent escaped property names.
export function parseFlatCallbackJSON(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  let rest = text.trim()
  if (!rest.startsWith('{')) throw new ApiError(400, '回调格式错误')
  rest = rest.slice(1).trimStart()
  if (rest === '}') return result
  while (rest) {
    const keyMatch = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(rest)
    if (!keyMatch) throw new ApiError(400, '回调格式错误')
    const key = JSON.parse(keyMatch[0]) as string
    if (Object.hasOwn(result, key)) throw new ApiError(400, '重复的回调参数')
    rest = rest.slice(keyMatch[0].length).trimStart()
    if (!rest.startsWith(':')) throw new ApiError(400, '回调格式错误')
    rest = rest.slice(1).trimStart()
    const valueMatch =
      /^(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|null)/.exec(
        rest,
      )
    if (!valueMatch) throw new ApiError(400, '回调字段格式错误')
    const value = JSON.parse(valueMatch[0])
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new ApiError(400, '回调数字格式错误')
    result[key] = value === null ? '' : String(value)
    rest = rest.slice(valueMatch[0].length).trimStart()
    if (rest === '}') return result
    if (!rest.startsWith(',')) throw new ApiError(400, '回调格式错误')
    rest = rest.slice(1).trimStart()
  }
  throw new ApiError(400, '回调格式错误')
}
