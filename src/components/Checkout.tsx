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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBotCheck } from './BotCheck'
import { useSite } from './Providers'
import { api, channels, money, parseSession, demoSession, normalizeDemoSession } from '../lib'
import type { AccountData, Order, Quote } from '../types'
import { PaymentOptions, usePaymentChannel } from './PaymentOptions'
import { paymentLimitError, planNames } from '../pricing'
import { refundSummary } from '../product-copy'
import { FunnelView } from './FunnelView'
import { trackFunnel, attributionSource, analyticsAllowed } from '../funnel-client'

export function Checkout() {
  const productId = useSearchParams().get('product')
  return <CheckoutContent key={productId} productId={productId} />
}

function CheckoutContent({ productId }: { productId: string | null }) {
  const { data, openLogin } = useSite()
  const bot = useBotCheck('purchase')
  const router = useRouter()
  const { message } = App.useApp()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [session, setSession] = useState('')
  const [sessionCollapsed, setSessionCollapsed] = useState(false)
  const sessionPreview = useRef<HTMLDivElement>(null)
  const sessionEmail = useMemo(() => {
    if (!session) return ''
    try {
      return parseSession(session).user.email
    } catch {
      return ''
    }
  }, [session])
  // Keep credentials only in this mounted checkout, never URL/storage/server DB.
  const verifiedSession = useRef<{ quoteId: string; value: string } | null>(null)
  const [contactEmail, setContactEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const { channel, setChannel, paymentAvailable } = usePaymentChannel()
  const [error, setError] = useState('')
  const [requestKey, setRequestKey] = useState('')
  const [upgradeId, setUpgradeId] = useState('')
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [balanceAmount, setBalanceAmount] = useState(0)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (sessionCollapsed) sessionPreview.current?.focus()
  }, [sessionCollapsed])
  useEffect(() => {
    const clear = () => {
      verifiedSession.current = null
    }
    window.addEventListener('pagehide', clear)
    return () => {
      clear()
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  useEffect(() => {
    if (!quote || Date.parse(quote.expiresAt) <= clock) verifiedSession.current = null
  }, [quote, clock])
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
  const paymentUnavailable = externalAmount > 0 && !paymentAvailable
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
      trackFunnel('verify_started', product.id)
      parseSession(session)
      const submittedSession = data?.mode === 'demo' ? normalizeDemoSession(session) : session
      const result = await api<Quote>('/quotes', {
        productId: product.id,
        turnstileToken: bot.token(),
        session: submittedSession,
        source: attributionSource(),
        analytics: analyticsAllowed(),
      })
      verifiedSession.current = { quoteId: result.id, value: submittedSession }
      setQuote(result)
      setBalanceAmount(0)
      setClock(Date.now())
      setSession('')
      setSessionCollapsed(false)
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
    if (data?.mode === 'live' && verifiedSession.current?.quoteId !== quote.id) {
      setQuote(null)
      setError('账号信息已清除，请重新检查账号')
      return
    }
    if (expired || limitError || paymentUnavailable) {
      setError(
        expired
          ? '报价已过期，请重新验证账号'
          : paymentUnavailable
            ? '在线支付暂未开放，请稍后再试或使用足额账户余额'
            : limitError,
      )
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
        session:
          verifiedSession.current?.quoteId === quote.id ? verifiedSession.current.value : undefined,
      })
      verifiedSession.current = null
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
      <FunnelView event="checkout_view" productId={product.id} />
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
                  disabled={busy}
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
                  disabled={busy}
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
                <Button type="link" disabled={busy} onClick={() => openLogin(true)}>
                  登录
                </Button>
              </p>
            </Form>
          ) : (
            <p className="muted mt-24">联系邮箱：{data.user.email}</p>
          )}

          {!quote ? (
            <>
              <Form layout="vertical" requiredMark={false} disabled={busy}>
                <div className="session-guide">
                  <strong>如何准备账号信息？</strong>
                  <ol>
                    <li>登录需要充值的 ChatGPT 账号，确认当前邮箱。</li>
                    <li>
                      <Link href="/guide#account-info" target="_blank">
                        打开账号信息操作指引 ↗
                      </Link>
                      ，复制完整账号信息。
                    </li>
                    <li>粘贴到下方，核对识别出的邮箱，再验证账号。</li>
                  </ol>
                  <details className="session-explanation">
                    <summary>为什么需要这些信息？</summary>
                    <p>
                      会话信息是敏感登录凭证，用于检查账号和执行本次充值。本站会将其转交充值服务方处理，
                      不将完整会话写入本站数据库或浏览器持久存储。请确认服务方和用途后再提交。
                    </p>
                  </details>
                </div>
                {sessionEmail && (
                  <div className="session-preview" ref={sessionPreview} tabIndex={-1}>
                    <div aria-live="polite">
                      <span>已读取充值邮箱 · 尚未验证</span>
                      <strong>{sessionEmail}</strong>
                      <small>请确认这是需要充值的账号。</small>
                    </div>
                    <Button
                      type="link"
                      onClick={() => {
                        setSessionCollapsed((current) => !current)
                        if (sessionCollapsed)
                          requestAnimationFrame(() =>
                            document.getElementById('checkout-session')?.focus(),
                          )
                      }}
                    >
                      {sessionCollapsed ? '编辑账号信息' : '收起账号信息'}
                    </Button>
                  </div>
                )}
                {!sessionCollapsed && (
                  <Form.Item
                    label="账号会话信息（Session）"
                    htmlFor="checkout-session"
                    extra={
                      data.mode === 'demo'
                        ? '已填入示例 Session，可修改邮箱体验流程；请勿粘贴真实登录凭证。'
                        : '粘贴完整内容后会显示充值邮箱，供你核对。'
                    }
                  >
                    <Input.TextArea
                      id="checkout-session"
                      value={session}
                      onChange={(e) => setSession(e.target.value)}
                      onPaste={(event) => {
                        const pasted = event.clipboardData.getData('text')
                        try {
                          parseSession(pasted)
                        } catch {
                          return
                        }
                        event.preventDefault()
                        setSession(pasted)
                        setSessionCollapsed(true)
                        setError('')
                      }}
                      rows={4}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="在此粘贴完整的账号会话 JSON"
                      aria-label="账号会话信息"
                    />
                  </Form.Item>
                )}
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
                <SafetyCertificateOutlined /> 此步仅检查账号与价格，不会扣款
              </p>
            </>
          ) : (
            <>
              <div className="verified-account">
                <div>
                  <small>
                    <CheckCircleFilled /> 本次充值账号
                  </small>
                  <strong>{quote.email}</strong>
                </div>
                <Button
                  type="link"
                  disabled={busy}
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
                  disabled={busy}
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
                  disabled={busy}
                  amount={externalAmount}
                />
              )}
              {data.user && (
                <div className="mt-24">
                  <Checkbox
                    checked={balanceAmount > 0}
                    disabled={busy || !walletBalance}
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
                        disabled={busy}
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
              {!paymentUnavailable && limitError && (
                <Alert className="mt-20" type="warning" showIcon title={limitError} />
              )}
              <div className="checkout-total">
                <span>
                  {externalAmount === 0 || paymentUnavailable
                    ? '还需支付'
                    : `${channels[channel]}待付`}
                </span>
                <strong>{money(externalAmount)}</strong>
              </div>
              <div className="checkout-conditions">
                <strong>付款前请确认</strong>
                <p>{refundSummary}</p>
              </div>
              <Button
                type="primary"
                size="large"
                block
                loading={busy}
                onClick={purchase}
                disabled={expired || !!limitError || paymentUnavailable}
              >
                {`确认订单 · ${money(quote.amount)}`} <ArrowRightOutlined />
              </Button>
              <p className="tiny muted">
                本站不自动续扣。提交前请阅读{' '}
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
            <p className="tiny muted">本站按本次订单收费，不自动续扣。</p>
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
