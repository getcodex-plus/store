import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { integration } from './config'
import { db } from '../db'
import { settingsData } from '../data'
import { ApiError } from '../config'
export async function sendLoginEmail(to: string, code: string, requestId: string) {
  return sendEmail(
    to,
    'GetCodex Plus 登录验证码',
    `你的验证码是 ${code}，10 分钟内有效。请勿转发给他人。如果不是你本人操作，请忽略此邮件。`,
    `login-code/${requestId}`,
  )
}
export async function sendEmail(to: string, subject: string, text: string, requestId: string) {
  const provider =
    settingsData((await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body).emailProvider ||
    'resend'
  const config = await integration(provider)
  if (provider === 'resend') {
    const { data, error } = await new Resend(config.apiKey).emails.send(
      { from: config.from, to: [to], subject, text },
      { idempotencyKey: requestId, signal: AbortSignal.timeout(15000) },
    )
    if (error || !data?.id) throw new ApiError(503, '验证码邮件暂时未能发送，请稍后重试')
    return
  }
  const smtp = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: config.port === '465',
    requireTLS: true,
    connectionTimeout: 15000,
    socketTimeout: 20000,
    auth: { user: config.user, pass: config.password },
  })
  await smtp.sendMail({ from: config.from, to, subject, text })
}
