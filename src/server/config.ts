import { parseTrustedProxies } from './client-ip'

export const demo = process.env.APP_MODE !== 'live'
export const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export function requireSetting(name: string): string {
  const value = process.env[name]
  if (!value) throw new ApiError(503, `服务尚未配置完成（${name}），请联系管理员`)
  return value
}
export function validateRuntime() {
  if (process.env.APP_MODE && !['live', 'demo'].includes(process.env.APP_MODE))
    throw new ApiError(503, '运行模式配置无效（APP_MODE 仅支持 live 或 demo）')
  try {
    parseTrustedProxies()
  } catch {
    throw new ApiError(503, 'TRUSTED_PROXIES 配置格式无效')
  }
  if (demo && !['localhost', '127.0.0.1'].includes(new URL(appUrl).hostname))
    throw new ApiError(503, '演示环境只允许本地运行')
  if (!demo && !appUrl.startsWith('https://')) throw new ApiError(503, '正式环境必须使用 HTTPS')
}
