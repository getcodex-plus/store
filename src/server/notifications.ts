import { pool } from './db'
import { appUrl, demo } from './config'
import { sendEmail } from './integrations/email'
const labels: Record<string, string> = {
  cancelled: '订单已取消，已抵扣余额已退回',
  unpaid: '等待付款',
  processing: '付款已收到，正在充值',
  completed: '充值已完成',
  needs_session: '需要更新充值账号信息',
  failed: '需要人工协助处理',
  refunded: '已退回账户钱包',
}
export async function deliverOrderEmail() {
  // The row lease survives restarts. Resend also deduplicates retries by this stable event id.
  const job = (
    await pool.query(`UPDATE email_outbox SET run_at=now()+interval '2 minutes',attempts=attempts+1
    WHERE id=(SELECT id FROM email_outbox WHERE sent_at IS NULL AND run_at<=now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`)
  ).rows[0]
  if (!job) return
  try {
    const order = (
      await pool.query('SELECT contact_email,amount FROM orders WHERE id=$1', [job.order_id])
    ).rows[0]
    if (!demo && order?.contact_email)
      await sendEmail(
        order.contact_email,
        `GetCodex Plus 订单通知：${labels[job.status] || '状态更新'}`,
        `订单号：${job.order_id}\n状态：${labels[job.status] || job.status}\n金额：¥${(order.amount / 100).toFixed(2)}\n查看订单：${appUrl}/orders/${job.order_id}\n\n请使用下单时的浏览器打开；更换设备后，用本邮箱验证码登录即可查看。请勿转发验证码。`,
        job.id,
      )
    await pool.query('UPDATE email_outbox SET sent_at=now() WHERE id=$1', [job.id])
  } catch {
    await pool.query("UPDATE email_outbox SET run_at=now()+$2*interval '1 second' WHERE id=$1", [
      job.id,
      Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7)),
    ])
  }
}
