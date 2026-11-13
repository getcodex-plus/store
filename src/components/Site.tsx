'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  App,
  Avatar,
  Button,
  Dropdown,
  Modal,
  Form,
  Input,
  Alert,
  Space,
  Tabs,
  Divider,
} from 'antd'
import {
  ArrowRightOutlined,
  LogoutOutlined,
  UserOutlined,
  WalletOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,
} from '@ant-design/icons'
import { authClient, authResult } from '../auth-client'
import { useEffect, useState } from 'react'
import { useBotCheck } from './BotCheck'
import { useSite } from './Providers'
import { api } from '../lib'

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link href="/" className={`brand ${light ? 'brand-light' : ''}`} aria-label="GetGPT 首页">
      <span className="brand-mark">
        g<span>✦</span>
      </span>
      <span>
        GetGPT<span className="brand-dot">.</span>
      </span>
    </Link>
  )
}
export function LoginDialog() {
  const { data, loginOpen, openLogin, refresh } = useSite()
  const bot = useBotCheck('login', loginOpen)
  const botOptions = () => ({ headers: { 'x-turnstile-token': bot.token() || '' } })
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [sent, setSent] = useState(false)
  const [demoCode, setDemoCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [mode, setMode] = useState('email')
  const [mfa, setMfa] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMethods, setMfaMethods] = useState<string[]>([])
  const [mfaDemoCode, setMfaDemoCode] = useState('')
  const [mfaCountdown, setMfaCountdown] = useState(0)
  async function sendMfaCode() {
    authResult(await authClient.twoFactor.sendOtp({}))
    setMfaCountdown(60)
    if (data?.mode === 'demo') {
      const result = await api<{ demoCode?: string }>('/demo/code', {
        email: form.getFieldValue('email'),
      })
      setMfaDemoCode(result.demoCode || '')
    } else message.success('验证码已发送至你的账号邮箱')
  }
  async function finish(result: { twoFactorRedirect?: boolean; twoFactorMethods?: string[] }) {
    if (result.twoFactorRedirect) {
      const methods = result.twoFactorMethods || ['totp']
      const preferred = methods.includes('totp') ? 'totp' : 'otp'
      setMfaMethods(methods)
      setMfa(preferred)
      setMfaCode('')
      setMfaDemoCode('')
      setMfaCountdown(0)
      if (preferred === 'otp') await sendMfaCode()
      return
    }
    await refresh()
    openLogin(false)
    message.success('登录成功')
    form.resetFields()
    setSent(false)
    setDemoCode('')
    setMfa('')
    setMfaCode('')
    setMfaMethods([])
    setMfaDemoCode('')
  }
  async function passkey() {
    setBusy(true)
    try {
      await finish(
        authResult(await authClient.signIn.passkey({ fetchOptions: botOptions() })) as {
          twoFactorRedirect?: boolean
        },
      )
    } catch {
      message.error('未完成 Passkey 验证，请重试或使用其他登录方式')
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])
  useEffect(() => {
    if (mfaCountdown <= 0) return
    const timer = setTimeout(() => setMfaCountdown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [mfaCountdown])
  async function send() {
    try {
      await form.validateFields(['email'])
      setBusy(true)
      authResult(
        await authClient.emailOtp.sendVerificationOtp(
          {
            email: form.getFieldValue('email'),
            type: 'sign-in',
          },
          botOptions(),
        ),
      )
      const result =
        data?.mode === 'demo'
          ? await api<{ demoCode?: string }>('/demo/code', { email: form.getFieldValue('email') })
          : {}
      setSent(true)
      setDemoCode(result.demoCode || '')
      setCountdown(60)
      if (!result.demoCode) message.success('验证码已发送，请检查邮箱')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  async function submit(values: { email: string; code: string; password: string }) {
    setBusy(true)
    try {
      let referral
      try {
        const stored = JSON.parse(localStorage.getItem('getgpt_referral') || 'null')
        if (stored?.expires > Date.now()) referral = stored.code
      } catch {}
      const fetchOptions = {
        headers: {
          ...botOptions().headers,
          ...(referral ? { 'x-getgpt-referral': referral } : {}),
        },
      }
      const result =
        mode === 'password'
          ? await authClient.signIn.email(
              { email: values.email, password: values.password },
              fetchOptions,
            )
          : await authClient.signIn.emailOtp(
              { email: values.email, otp: values.code },
              fetchOptions,
            )
      await finish(authResult(result) as { twoFactorRedirect?: boolean })
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  return (
    <Modal
      title="欢迎来到 GetGPT"
      open={loginOpen}
      onCancel={() => openLogin(false)}
      footer={null}
      width={420}
      destroyOnHidden
    >
      {bot.widget}
      {mfa ? (
        <>
          <h3>完成二步验证</h3>
          {mfaMethods.includes('totp') && mfaMethods.includes('otp') && (
            <Tabs
              activeKey={mfa}
              onChange={(value) => {
                setMfa(value)
                setMfaCode('')
              }}
              items={[
                { key: 'totp', label: '身份验证器' },
                { key: 'otp', label: '邮箱验证码' },
              ]}
            />
          )}
          <p className="muted">
            {mfa === 'totp'
              ? '输入身份验证器中的 6 位动态验证码。'
              : '输入发送至账号邮箱的 6 位验证码。'}
          </p>
          <Input
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            autoComplete="one-time-code"
            aria-label={mfa === 'totp' ? 'TOTP 动态验证码' : '邮箱二步验证码'}
            placeholder={mfa === 'totp' ? '6 位动态验证码' : '6 位邮箱验证码'}
            inputMode="numeric"
            maxLength={6}
          />
          {mfa === 'otp' && (
            <>
              <Button
                className="mt-20"
                disabled={mfaCountdown > 0 || busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await sendMfaCode()
                  } catch (e) {
                    message.error((e as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {mfaCountdown > 0 ? `${mfaCountdown}s 后可重新发送` : '发送邮箱验证码'}
              </Button>
              {mfaDemoCode && (
                <Alert className="mt-20" type="info" title={`本地演示二步验证码：${mfaDemoCode}`} />
              )}
            </>
          )}
          <Button
            className="mt-24"
            block
            type="primary"
            loading={busy}
            disabled={!/^\d{6}$/.test(mfaCode)}
            onClick={async () => {
              setBusy(true)
              try {
                authResult(
                  mfa === 'totp'
                    ? await authClient.twoFactor.verifyTotp({ code: mfaCode }, botOptions())
                    : await authClient.twoFactor.verifyOtp({ code: mfaCode }, botOptions()),
                )
                await finish({})
              } catch (e) {
                message.error((e as Error).message)
              } finally {
                bot.reset()
                setBusy(false)
              }
            }}
          >
            完成二步验证
          </Button>
          <Button className="mt-24" block onClick={() => setMfa('')}>
            返回登录
          </Button>
        </>
      ) : (
        <>
          <p className="muted">新用户可通过邮箱验证码创建账号。</p>
          <Button block icon={<KeyOutlined />} onClick={passkey} loading={busy}>
            使用 Passkey 登录
          </Button>
          <Divider plain>或</Divider>
          <Tabs
            activeKey={mode}
            onChange={setMode}
            items={[
              { key: 'email', label: '邮箱验证码' },
              { key: 'password', label: '密码登录' },
            ]}
          />
          <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item
              name="email"
              label="邮箱地址"
              rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
            >
              <Input
                placeholder="you@example.com"
                autoComplete="email"
                onChange={() => {
                  setSent(false)
                  setDemoCode('')
                }}
              />
            </Form.Item>
            {mode === 'email' ? (
              <Form.Item label="验证码">
                <Space.Compact block>
                  <Form.Item
                    name="code"
                    noStyle
                    rules={[{ required: true, len: 6, message: '请输入 6 位验证码' }]}
                  >
                    <Input
                      placeholder="6 位验证码"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                    />
                  </Form.Item>
                  <Button onClick={send} loading={busy && !sent} disabled={countdown > 0}>
                    {countdown > 0 ? `${countdown}s` : '获取验证码'}
                  </Button>
                </Space.Compact>
              </Form.Item>
            ) : (
              <Form.Item name="password" label="密码" rules={[{ required: true }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
            )}
            {demoCode && (
              <Alert
                type="info"
                showIcon
                title={`本地演示验证码：${demoCode}`}
                description="演示环境不发送邮件，请使用测试邮箱。"
              />
            )}
            <Button type="primary" htmlType="submit" block loading={busy} className="mt-20">
              登录 / 注册
            </Button>
            {data?.mode === 'demo' && (
              <p className="tiny muted">
                后台演示账号：admin@example.com，同样通过本地验证码登录。
              </p>
            )}
          </Form>
        </>
      )}
    </Modal>
  )
}
export function SiteHeader() {
  const { data, error, openLogin, refresh } = useSite()
  const path = usePathname()
  const { message } = App.useApp()
  const admin = path.startsWith('/admin')
  const logout = async () => {
    authResult(await authClient.signOut())
    await refresh()
    message.success('已退出登录')
  }
  return (
    <>
      {!admin && (
        <header className="site-header">
          <div className="header-inner">
            <Brand />
            <nav aria-label="主导航">
              <Link className={path === '/' ? 'active' : ''} href="/#plans">
                套餐与升级
              </Link>
              <Link className={path === '/guide' ? 'active' : ''} href="/guide">
                新手指南
              </Link>
              <Link className={path === '/referral' ? 'active' : ''} href="/referral">
                邀请有礼 <span className="nav-gift">↗</span>
              </Link>
            </nav>
            <div className="header-actions">
              {data?.user ? (
                <>
                  <Link href="/account" className="account-shortcut">
                    我的订单
                  </Link>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        {
                          key: 'wallet',
                          label: <Link href="/wallet">我的钱包</Link>,
                          icon: <WalletOutlined />,
                        },
                        {
                          key: 'security',
                          label: <Link href="/security">账号安全</Link>,
                          icon: <KeyOutlined />,
                        },
                        ...(data.user.permissions.includes('admin:access')
                          ? [
                              {
                                key: 'admin',
                                label: <Link href="/admin">管理后台</Link>,
                                icon: <SafetyCertificateOutlined />,
                              },
                            ]
                          : []),
                        {
                          key: 'logout',
                          label: '退出登录',
                          icon: <LogoutOutlined />,
                          onClick: logout,
                        },
                      ],
                    }}
                  >
                    <Button shape="circle" aria-label="账号菜单">
                      <Avatar
                        size={28}
                        style={{ background: 'var(--surface-hover)', color: 'var(--accent)' }}
                        icon={<UserOutlined />}
                      />
                    </Button>
                  </Dropdown>
                </>
              ) : (
                <Button disabled={!data} type="primary" onClick={() => openLogin(true)}>
                  登录 / 注册 <ArrowRightOutlined />
                </Button>
              )}
            </div>
          </div>
        </header>
      )}
      {data?.mode === 'demo' && !admin && (
        <div className="demo-banner">
          <span className="status-dot" /> 本地演示 · 套餐价格为示例，不会真实扣款或充值
        </div>
      )}
      {error && !admin && (
        <div className="container">
          <Alert
            type="error"
            title="暂时无法连接服务"
            description={error}
            action={<Button onClick={refresh}>重试</Button>}
          />
        </div>
      )}
      <LoginDialog />
    </>
  )
}
export function SiteFooter() {
  const path = usePathname()
  if (path.startsWith('/admin')) return null
  return (
    <footer className="site-footer">
      <div className="container footer-content">
        <div>
          <Brand />
          <p>让好工具，触手可及。</p>
          <span className="tiny muted">独立充值服务，与 OpenAI 无隶属关系。</span>
        </div>
        <div className="footer-links">
          <Link href="/guide">使用指南</Link>
          <Link href="/wallet">我的钱包</Link>
          <Link href="/privacy">隐私说明</Link>
          <Link href="/terms">服务说明</Link>
        </div>
        <span className="footer-copy">© {new Date().getFullYear()} GetGPT</span>
      </div>
    </footer>
  )
}
