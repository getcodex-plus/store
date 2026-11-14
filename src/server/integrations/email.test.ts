import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setting: vi.fn(),
  integration: vi.fn(),
  resend: vi.fn(),
  smtp: vi.fn(),
  transport: vi.fn(),
}))
vi.mock('../db', () => ({
  db: { setting: { findUniqueOrThrow: mocks.setting } },
}))
vi.mock('./config', () => ({ integration: mocks.integration }))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.resend }
  },
}))
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.transport } }))

import { sendEmail, sendLoginEmail } from './email'

const settings = {
  rateBps: 200,
  settlementDays: 7,
  minimumWithdrawal: 1000,
  firstOrderOnly: false,
  alipay: true,
  wechat: true,
  crypto: false,
  fiatProvider: 'xorpay',
  emailProvider: 'sendflare',
}
const config = { from: 'hello@example.com', apiKey: 'sendflare-test-key' }
const success = { success: true, code: 0, data: { emailId: 'mail-123' } }

beforeEach(() => {
  mocks.setting.mockResolvedValue({ body: settings })
  mocks.integration.mockResolvedValue(config)
  mocks.resend.mockResolvedValue({ data: { id: 'resend-123' }, error: null })
  mocks.transport.mockReturnValue({ sendMail: mocks.smtp })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('email provider dispatch', () => {
  it('sends login codes through Sendflare using its bearer token and body field', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(success))
    vi.stubGlobal('fetch', fetcher)
    await sendLoginEmail('buyer@example.com', '123456', 'login-123')
    expect(mocks.integration).toHaveBeenCalledWith('sendflare')
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'https://api.sendflare.com/v1/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer sendflare-test-key',
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      from: config.from,
      to: 'buyer@example.com',
      subject: 'GetCodex Plus 登录验证码',
      body: '你的验证码是 123456，10 分钟内有效。请勿转发给他人。如果不是你本人操作，请忽略此邮件。',
    })
    expect(mocks.resend).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })

  it('preserves the complete Unicode order notification and line breaks', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(success))
    vi.stubGlobal('fetch', fetcher)
    const text = '订单号：o_123\n金额：¥10.00\n查看订单：https://example.com/orders/o_123'
    await sendEmail('buyer@example.com', '订单通知：充值已完成', text, 'event-123')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      to: 'buyer@example.com',
      subject: '订单通知：充值已完成',
      body: text,
    })
  })

  it.each([
    ['HTTP failure', () => Response.json(success, { status: 503 })],
    ['rate limit', () => Response.json({ message: 'token details' }, { status: 429 })],
    ['business rejection', () => Response.json({ success: false, code: 1001 })],
    ['nonzero code', () => Response.json({ success: true, code: 1001 })],
    ['missing status', () => Response.json({})],
    ['null response', () => Response.json(null)],
    ['invalid flag type', () => Response.json({ success: 'true', code: 0 })],
    ['invalid code type', () => Response.json({ success: true, code: '0' })],
    ['invalid JSON', () => new Response('not json')],
    ['redirect', () => new Response(null, { status: 302 })],
    [
      'timeout',
      () => {
        throw new DOMException('token details', 'TimeoutError')
      },
    ],
    [
      'network failure',
      () => {
        throw new Error('token details')
      },
    ],
  ])('fails safely on %s without falling back to another provider', async (_label, response) => {
    const fetcher = vi.fn().mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetcher)
    await expect(sendEmail('buyer@example.com', '测试', '正文', 'event-123')).rejects.toMatchObject(
      {
        status: 503,
        message: '邮件暂时未能发送，请稍后重试',
      },
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mocks.resend).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })

  it('does not send when the selected integration is disabled or missing', async () => {
    mocks.integration.mockRejectedValue(new Error('service disabled'))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(sendEmail('buyer@example.com', '测试', '正文', 'event-123')).rejects.toThrow(
      'service disabled',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps Resend as the default and preserves its idempotency key', async () => {
    mocks.setting.mockResolvedValue({ body: { ...settings, emailProvider: undefined } })
    await sendEmail('buyer@example.com', '测试', '正文', 'event-123')
    expect(mocks.integration).toHaveBeenCalledWith('resend')
    expect(mocks.resend).toHaveBeenCalledWith(
      { from: config.from, to: ['buyer@example.com'], subject: '测试', text: '正文' },
      { idempotencyKey: 'event-123', signal: expect.any(AbortSignal) },
    )
  })

  it('continues to send SMTP mail with TLS', async () => {
    mocks.setting.mockResolvedValue({ body: { ...settings, emailProvider: 'smtp' } })
    mocks.integration.mockResolvedValue({ ...config, host: 'smtp.example.com', port: '465' })
    await sendEmail('buyer@example.com', '测试', '正文', 'event-123')
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', secure: true, requireTLS: true }),
    )
    expect(mocks.smtp).toHaveBeenCalledWith({
      from: config.from,
      to: 'buyer@example.com',
      subject: '测试',
      text: '正文',
    })
  })
})
