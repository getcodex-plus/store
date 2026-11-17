import { db } from './db'
import { claimEmail, databaseNow } from './database-sql'
import { appUrl, demo } from './config'
import { sendEmail } from './integrations/email'
const labels: Record<string, string> = {
  cancelled: '订单已取消，已抵扣余额已退回',
  unpaid: '等待付款',
  processing: '付款已收到，正在充值',
  completed: '充值已完成',
  needs_session: '需要更新充值账号信息',
  failed: '需要人工协助处理',
  refunded: '退款已完成，请查看订单确认退款去向',
}
export async function deliverOrderEmail() {
  // The row lease survives restarts. Resend also deduplicates retries by this stable event id.
  const job = await claimEmail()
  if (!job) return
  try {
    const order = await db.order.findUnique({
      where: { id: job.orderId },
      select: {
        contactEmail: true,
        amount: true,
        listAmount: true,
        discountAmount: true,
        couponCode: true,
      },
    })
    if (!demo && order?.contactEmail) {
      const couponLine =
        order.discountAmount > 0 && order.couponCode
          ? `\n优惠码：${order.couponCode}（原价 ¥${(order.listAmount / 100).toFixed(2)}，已省 ¥${(order.discountAmount / 100).toFixed(2)}）`
          : ''
      await sendEmail(
        order.contactEmail,
        `GetCodex Plus 订单通知：${labels[job.status] || '状态更新'}`,
        `订单号：${job.orderId}\n状态：${labels[job.status] || job.status}\n应付金额：¥${(order.amount / 100).toFixed(2)}${couponLine}\n查看订单：${appUrl}/orders/${job.orderId}\n\n请使用下单时的浏览器打开；更换设备后，用本邮箱验证码登录即可查看。请勿转发验证码。`,
        job.id,
      )
    }
    await db.emailOutbox.update({ where: { id: job.id }, data: { sentAt: await databaseNow() } })
  } catch {
    await db.emailOutbox.update({
      where: { id: job.id },
      data: {
        runAt: new Date(
          (await databaseNow()).getTime() +
            Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7)) * 1000,
        ),
      },
    })
  }
}
