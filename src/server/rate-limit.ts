import { pool } from './db'
import { ApiError } from './config'
export async function rateLimit(key: string, limit: number, seconds: number) {
  const result = await pool.query(
    `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END,
    expires_at=CASE WHEN rate_limits.expires_at<now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count`,
    [key, seconds],
  )
  if (result.rows[0].count > limit) throw new ApiError(429, '操作太频繁，请稍后再试')
}
