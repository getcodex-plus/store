import { incrementRateLimit } from './database-sql'
import { ApiError } from './config'
export async function rateLimit(key: string, limit: number, seconds: number) {
  if ((await incrementRateLimit(key, seconds)) > limit)
    throw new ApiError(429, '操作太频繁，请稍后再试')
}
