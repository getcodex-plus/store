'use client'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Radio,
  Result,
  Skeleton,
  Select,
  Steps,
  Tag,
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { useBotCheck } from './BotCheck'
import { useSite } from './Providers'
import { api, channels, money, parseSession, demoSession, normalizeDemoSession } from '../lib'
import type { AccountData, Channel, Order, Quote } from '../types'
import { paymentLimitError, planNames } from '../pricing'

export function PaymentOptions({
  value,
  onChange,
  allowBalance = true,
  amount,
}: {
  value: Channel
  onChange: (v: Channel) => void
  allowBalance?: boolean
  amount?: number
}) {
  const { data } = useSite()
  const choices: Channel[] = [
    'alipay',
    'wechat',
    'crypto',
    ...(allowBalance ? ['balance' as const] : []),
  ]
  return (
    <Radio.Group
      className="payment-options"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {choices
        .filter((c) => c === 'balance' || data?.settings[c])
        .map((c) => (
          <Radio key={c} value={c}>
            <span className={`payment-logo ${c}`}>
              {c === 'alipay' ? '支' : c === 'wechat' ? '微' : c === 'crypto' ? '₮' : '¥'}
            </span>
            <span>{channels[c]}</span>
            {amount !== undefined &&
              c !== 'balance' &&
              data &&
              paymentLimitError(data.settings, c, amount) && <small>（不在金额范围内）</small>}
          </Radio>
        ))}
    </Radio.Group>
  )
}
export function Checkout() {
  const { data, openLogin } = useSite()
  const bot = useBotCheck('purchase')
  const productId = useSearchParams().get('product')
  const router = useRouter()
  const { message } = App.useApp()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [session, setSession] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [channel, setChannel] = useState<Channel>('alipay')
  const [error, setError] = useState('')
  const [requestKey, setRequestKey] = useState('')
  const [upgradeId, setUpgradeId] = useState('')
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [balanceAmount, setBalanceAmount] = useState(0)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (data?.mode === 'demo') setSession((current) => current || demoSession())
  }, [data?.mode])
  useEffect(() => {
    let active = true
    setWalletBalance(null)
    setBalanceAmount(0)
    if (data?.user)
      void api<AccountData>('/account')
        .then((account) => {
          if (active) setWalletBalance(account.balance)
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [data?.user?.id])
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (error) document.getElementById('checkout-error')?.focus()
  }, [error])
  const requestedProduct = data?.products.find((p) => p.id === productId)
  const product = requestedProduct?.upgrade
    ? data?.products.find((p) => p.id === upgradeId && p.upgrade) || requestedProduct
    : requestedProduct
  const walletUsed = balanceAmount
  const externalAmount = Math.max(0, (quote?.amount ?? 0) - walletUsed)
  const expired = quote ? clock >= new Date(quote.expiresAt).getTime() : false
  const limitError = data && quote ? paymentLimitError(data.settings, channel, externalAmount) : ''
  if (!data)
    return (
      <div className="container page-content">
        <Skeleton active />
      </div>
    )
  if (!product)
    return (
      <Result
        status="404"
        title="请选择有效套餐"
        extra={<Link href="/#plans">返回套餐列表</Link>}
      />
    )
  async function verify() {
    if (!product || !consent) return
    if (!data?.user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      setError('请填写有效的联系邮箱，用于接收订单通知')
      return
    }
    setBusy(true)
    setError('')
    try {
      parseSession(session)
      const result = await api<Quote>('/quotes', {
        productId: product.id,
        turnstileToken: bot.token(),
        session: data?.mode === 'demo' ? normalizeDemoSession(session) : session,
      })
      setQuote(result)
      setBalanceAmount(0)
      setClock(Date.now())
      setSession('')
      setRequestKey(crypto.randomUUID())
      message.success('账号检查已完成')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  async function purchase() {
    if (!data?.user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      setError('请填写有效的联系邮箱，用于接收订单通知')
      return
    }
    if (!quote) return
    if (expired || limitError) {
      setError(expired ? '报价已过期，请重新验证账号' : limitError)
      return
    }
    setBusy(true)
    setError('')
    try {
      let referralCode: string | undefined
      try {
        const referral = JSON.parse(localStorage.getItem('getgpt_referral') || 'null')
        if (referral?.expires > Date.now()) referralCode = referral.code
      } catch {}
      const order = await api<Order>('/orders', {
        quoteId: quote.id,
        turnstileToken: bot.token(),
        channel,
        requestKey,
        contactEmail: contactEmail.trim().toLowerCase() || undefined,
        balanceAmount: walletUsed,
        referralCode,
      })
      router.push(`/orders/${order.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  return (
    <main className="container checkout-page">
      <Link href="/#plans" className="text-link">
        <ArrowLeftOutlined /> 返回套餐
      </Link>
      <div className="page-title">
        <h1>{product.upgrade ? '确认本次升级' : '确认本次充值'}</h1>
        <p>核对账号与价格后再付款。{!data.user && '无需提前注册。'}</p>
      </div>
      <div className="checkout-progress">
        <Steps
          size="small"
          responsive={false}
          className="checkout-steps"
          current={quote ? 1 : 0}
          items={[{ title: '填写账号' }, { title: '核对订单' }, { title: '付款到账' }]}
        />
      </div>
      <div className="checkout-layout">
        <Card className="checkout-form">
          <div className="panel-heading">
            <div>
              <h2>{quote ? '核对订单，选择支付方式' : '确认充值账号'}</h2>
              <p>
                {quote
                  ? '请核对联系邮箱、充值账号与应付金额。'
                  : '填写联系邮箱，再确认需要充值的账号。'}
              </p>
            </div>
          </div>
          {error && (
            <div id="checkout-error" tabIndex={-1} className="mb-24">
              <Alert type="error" title={error} showIcon />
            </div>
          )}
          {product.upgrade && (
            <Form layout="vertical">
              <Form.Item label="想升级到哪个套餐？">
                <Select
                  aria-label="目标升级套餐"
                  styles={{ popup: { root: { maxWidth: 'calc(100vw - 36px)' } } }}
                  value={product.id}
                  options={data.products
                    .filter((p) => p.upgrade)
                    .map((p) => ({ value: p.id, label: planNames[p.plan] || p.name }))}
                  onChange={(value) => {
                    setUpgradeId(value)
                    setQuote(null)
                    setBalanceAmount(0)
                    setError('')
                  }}
                />
              </Form.Item>
            </Form>
          )}
          {bot.widget}
          {!data.user ? (
            <Form layout="vertical" className="mt-24">
              <Form.Item
                label="联系邮箱"
                htmlFor="checkout-contact-email"
                required
                extra="用于接收通知和找回订单，可以与充值账号邮箱不同。"
              >
                <Input
                  id="checkout-contact-email"
                  aria-label="联系邮箱"
                  required
                  type="email"
                  autoComplete="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="name@example.com"
                  maxLength={254}
                />
              </Form.Item>
              <p className="tiny muted">
                无需注册即可购买。已有账号？
                <Button type="link" onClick={() => openLogin(true)}>
                  登录
                </Button>
              </p>
            </Form>
          ) : (
            <p className="muted mt-24">联系邮箱：{data.user.email}</p>
          )}

          {!quote ? (
            <>
              <Form layout="vertical" requiredMark={false}>
                <div className="session-guide">
                  <strong>如何准备账号信息？</strong>
                  <ol>
                    <li>在浏览器登录需要充值的 ChatGPT 账号。</li>
                    <li>获取包含邮箱、accessToken 和 sessionToken 的完整会话 JSON。</li>
                    <li>
                      复制全部内容，粘贴到下方。
                      <Link href="/guide" target="_blank">
                        {' '}
                        查看详细说明 ↗
                      </Link>
                    </li>
                  </ol>
                </div>
                <Form.Item
                  label="账号会话信息（Session）"
                  extra={
                    data.mode === 'demo'
                      ? '已填入示例 Session，可修改邮箱体验流程；请勿粘贴真实登录凭证。'
                      : undefined
                  }
                >
                  <Input.TextArea
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                    rows={6}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="在此粘贴完整的账号会话 JSON"
                    aria-label="账号会话信息"
                  />
                </Form.Item>
                <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)}>
                  我确认有权使用该账号，知晓会话信息是敏感登录凭证，并同意用于本次验证与充值。
                </Checkbox>
              </Form>
              <Button
                type="primary"
                size="large"
                block
                loading={busy}
                disabled={!consent}
                onClick={verify}
                className="mt-24"
              >
                验证账号并确认价格 <ArrowRightOutlined />
              </Button>
              <p className="secure-note">
                <SafetyCertificateOutlined /> 验证不会发起扣款
              </p>
            </>
          ) : (
            <>
              <div className="verified-account">
                <CheckCircleFilled />
                <div>
                  <small>本次充值账号</small>
                  <strong>{quote.email}</strong>
                </div>
                <Button
                  type="link"
                  onClick={() => {
                    setQuote(null)
                    setConsent(false)
                  }}
                >
                  更换
                </Button>
              </div>
              {product.upgrade && (
                <Alert
                  className="mt-24"
                  type="info"
                  showIcon
                  title={`${planNames[quote.currentPlan || ''] || quote.currentPlan || '当前套餐'} → ${planNames[quote.targetPlan || product.plan] || product.name}`}
                  description={`本次升级总价 ${money(quote.amount)}，已包含服务费用。${data.mode === 'demo' ? '当前为演示报价。' : ''}`}
                />
              )}
              <p className="tiny muted mt-20">
                {expired
                  ? '报价已过期，请重新验证账号。'
                  : `报价还剩 ${Math.max(0, Math.ceil((new Date(quote.expiresAt).getTime() - clock) / 60000))} 分钟有效。`}
                <Button
                  type="link"
                  onClick={() => {
                    setQuote(null)
                    setBalanceAmount(0)
                  }}
                >
                  重新验证
                </Button>
              </p>
              <h3 className="mt-24">{externalAmount === 0 ? '使用余额完成付款' : '支付方式'}</h3>
              {externalAmount > 0 && (
                <PaymentOptions
                  value={channel}
                  onChange={setChannel}
                  allowBalance={false}
                  amount={externalAmount}
                />
              )}
              {data.user && (
                <div className="mt-24">
                  <Checkbox
                    checked={balanceAmount > 0}
                    disabled={!walletBalance}
                    onChange={(e) =>
                      setBalanceAmount(
                        e.target.checked ? Math.min(walletBalance ?? 0, quote.amount) : 0,
                      )
                    }
                  >
                    使用账户余额抵扣（
                    {walletBalance === null ? '余额暂未加载' : `可用 ${money(walletBalance)}`}）
                  </Checkbox>
                  {balanceAmount > 0 && (
                    <Form.Item label="本次抵扣（元）" className="mt-20">
                      <InputNumber
                        aria-label="本次余额抵扣"
                        min={0}
                        max={Math.min(walletBalance ?? 0, quote.amount) / 100}
                        precision={2}
                        value={balanceAmount / 100}
                        onChange={(v) => setBalanceAmount(Math.round((v ?? 0) * 100))}
                      />
                    </Form.Item>
                  )}
                </div>
              )}
              <div className="payment-breakdown">
                <div>
                  <span>订单总价</span>
                  <span>{money(quote.amount)}</span>
                </div>
                <div>
                  <span>余额抵扣</span>
                  <span>−{money(walletUsed)}</span>
                </div>
              </div>
              {limitError && <Alert className="mt-20" type="warning" showIcon title={limitError} />}
              <div className="checkout-total">
                <span>{externalAmount === 0 ? '还需支付' : `${channels[channel]}待付`}</span>
                <strong>{money(externalAmount)}</strong>
              </div>
              <Button
                type="primary"
                size="large"
                block
                loading={busy}
                onClick={purchase}
                disabled={expired || !!limitError}
              >
                {`确认订单 · ${money(quote.amount)}`} <ArrowRightOutlined />
              </Button>
              <p className="tiny muted">
                提交前请阅读{' '}
                <Link href="/terms" target="_blank">
                  服务说明
                </Link>{' '}
                与{' '}
                <Link href="/privacy" target="_blank">
                  隐私说明
                </Link>
                。
              </p>
            </>
          )}
        </Card>
        <aside>
          <Card className="order-summary">
            <div className="summary-heading">
              <span className="muted">已选套餐</span>
              <Link href="/#plans" className="text-link">
                更换套餐
              </Link>
            </div>
            <h2>{product.name}</h2>
            <p className="muted">{product.subtitle}</p>
            <div className="summary-price">
              {!quote && product.upgrade
                ? '验证账号后报价'
                : !quote && product.priceStatus === 'pending'
                  ? '价格更新中'
                  : money(quote?.amount ?? product.price)}
            </div>
            <details className="summary-details">
              <summary>查看套餐内容</summary>
              <ul>
                {product.features.map((f) => (
                  <li key={f}>✓ {f}</li>
                ))}
              </ul>
            </details>
            <Tag variant="filled" color="default">
              充值到你自己的账号
            </Tag>
          </Card>
          <div className="checkout-help">
            <h3>已有订阅？</h3>
            <p>请先确认目标套餐，账号检查通过后再付款。不要重复提交相同订单。</p>
            <Link href="/guide">查看新手指南 →</Link>
          </div>
        </aside>
      </div>
    </main>
  )
}
