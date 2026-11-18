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
  Space,
  Steps,
  Tag,
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  SafetyCertificateOutlined,
  TagOutlined,
} from '@ant-design/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBotCheck } from './BotCheck'
import { useSite } from './Providers'
import { api, channels, money, parseSession, demoSession, normalizeDemoSession } from '../lib'
import type { AccountData, Order, Quote } from '../types'
import { PaymentOptions, usePaymentChannel } from './PaymentOptions'
import { paymentLimitError } from '../pricing'
import { FunnelView } from './FunnelView'
import { trackFunnel, attributionSource, analyticsAllowed } from '../funnel-client'
import { normalizeCouponCode, productCouponPreview } from '../coupons'

export function Checkout() {
  const productId = useSearchParams().get('product')
  return <CheckoutContent key={productId} productId={productId} />
}

function CheckoutContent({ productId }: { productId: string | null }) {
  const { data, openLogin, coupon, couponBusy, applyCoupon, clearCoupon } = useSite()
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
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [balanceAmount, setBalanceAmount] = useState(0)
  const [clock, setClock] = useState(Date.now())
  const [couponOpen, setCouponOpen] = useState(false)
  const [couponInput, setCouponInput] = useState('')
  const [couponFeedback, setCouponFeedback] = useState<{
    type: 'error' | 'warning'
    text: string
  } | null>(null)

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

  // Keep quote-level coupon preview synced when quote or user session changes.
  useEffect(() => {
    if (!quote || !coupon?.valid || !coupon.code) return
    if (coupon.quote?.quoteId === quote.id) return
    void applyCoupon(coupon.code, { quoteId: quote.id, silent: true })
  }, [quote, coupon?.valid, coupon?.code, coupon?.quote?.quoteId, data?.user?.id, applyCoupon])

  const product = data?.products.find((p) => p.id === productId)

  const itemPreview = product ? productCouponPreview(product, coupon) : null
  const quoteCoupon =
    quote && coupon?.valid && coupon.quote?.quoteId === quote.id ? coupon.quote : null
  const discountAmount = quote
    ? quoteCoupon?.eligible
      ? quoteCoupon.discountAmount
      : 0
    : itemPreview?.eligible
      ? itemPreview.discountAmount
      : 0
  const payableAmount = quote
    ? quoteCoupon?.eligible
      ? quoteCoupon.finalAmount
      : quote.amount
    : itemPreview?.eligible
      ? itemPreview.finalAmount
      : (product?.price ?? 0)

  useEffect(() => {
    if (quote && balanceAmount > payableAmount) {
      setBalanceAmount(payableAmount)
    }
  }, [quote, balanceAmount, payableAmount])

  const walletUsed = Math.min(balanceAmount, walletBalance ?? balanceAmount, payableAmount)
  const externalAmount = Math.max(0, (quote ? payableAmount : 0) - walletUsed)
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

  async function handleApplyCoupon() {
    const normalized = normalizeCouponCode(couponInput)
    if (!normalized) {
      setCouponFeedback({ type: 'error', text: '请输入优惠码' })
      return
    }
    setCouponFeedback(null)
    const preview = await applyCoupon(normalized, { quoteId: quote?.id, silent: true })
    if (!preview.valid) {
      setCouponFeedback({ type: 'error', text: preview.reason || '优惠码无效或已过期' })
      return
    }
    setCouponInput('')
    setCouponOpen(false)
    if (quote) setRequestKey(crypto.randomUUID())
    if (quote && preview.quote && !preview.quote.eligible) {
      setCouponFeedback({
        type: 'warning',
        text: `${preview.quote.reason || '当前订单不满足此优惠码条件'}（将按原价结算）`,
      })
    } else {
      message.success(`已启用优惠码 ${preview.code}`)
    }
  }

  function handleClearCoupon() {
    clearCoupon()
    setCouponFeedback(null)
    setCouponInput('')
    setCouponOpen(false)
    if (quote) setRequestKey(crypto.randomUUID())
  }

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
      if (coupon?.valid && coupon.code) {
        await applyCoupon(coupon.code, { quoteId: result.id, silent: true })
      }
      verifiedSession.current = { quoteId: result.id, value: submittedSession }
      setQuote(result)
      setBalanceAmount(0)
      setClock(Date.now())
      setSession('')
      setSessionCollapsed(false)
      setCouponFeedback(null)
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
      const appliedCouponCode = coupon?.valid && quoteCoupon?.eligible ? coupon.code : undefined
      const order = await api<Order>('/orders', {
        quoteId: quote.id,
        turnstileToken: bot.token(),
        channel,
        requestKey,
        contactEmail: contactEmail.trim().toLowerCase() || undefined,
        balanceAmount: walletUsed,
        referralCode,
        couponCode: appliedCouponCode,
        session:
          verifiedSession.current?.quoteId === quote.id ? verifiedSession.current.value : undefined,
      })
      verifiedSession.current = null
      router.push(`/orders/${order.id}`)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      if (msg.includes('优惠码')) {
        setRequestKey(crypto.randomUUID())
      }
    } finally {
      bot.reset()
      setBusy(false)
    }
  }

  const couponSection = (
    <div className="checkout-coupon-box">
      {coupon?.valid && !couponOpen ? (
        <div className="checkout-coupon-active">
          <div className="checkout-coupon-info">
            <div className="checkout-coupon-title">
              <TagOutlined />
              <code className="coupon-code-chip">{coupon.code}</code>
              <span>{coupon.summary}</span>
            </div>
            {quote ? (
              quoteCoupon ? (
                quoteCoupon.eligible ? (
                  <small className="coupon-saving-text">
                    本单已减 {money(quoteCoupon.discountAmount)}，折后{' '}
                    {money(quoteCoupon.finalAmount)}
                  </small>
                ) : (
                  <small className="coupon-ineligible-text">
                    {quoteCoupon.reason || '当前订单不可用此优惠码'}（将按原价结算）
                    {coupon.requireLogin && !data.user && (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="inline-link-btn"
                          onClick={() => openLogin(true)}
                        >
                          立即登录
                        </button>
                      </>
                    )}
                  </small>
                )
              ) : (
                <small className="muted">正在计算本单优惠金额…</small>
              )
            ) : itemPreview?.eligible ? (
              <small className="coupon-saving-text">
                预计立省 {money(itemPreview.discountAmount)}，券后 {money(itemPreview.finalAmount)}
              </small>
            ) : (
              <small className="coupon-ineligible-text">
                {itemPreview?.reason || '当前套餐不满足此优惠码条件'}
              </small>
            )}
          </div>
          <div className="checkout-coupon-actions">
            <Button
              type="link"
              size="small"
              disabled={busy || couponBusy}
              onClick={() => {
                setCouponInput(coupon.code)
                setCouponFeedback(null)
                setCouponOpen(true)
              }}
            >
              更换
            </Button>
            <Button
              type="link"
              size="small"
              disabled={busy || couponBusy}
              onClick={handleClearCoupon}
            >
              不使用
            </Button>
          </div>
        </div>
      ) : couponOpen ? (
        <div className="checkout-coupon-editor">
          <Space.Compact block>
            <Input
              aria-label="优惠码"
              placeholder="输入优惠码，例如 PLUS20"
              value={couponInput}
              disabled={busy || couponBusy}
              maxLength={32}
              onChange={(e) => {
                setCouponInput(e.target.value.toUpperCase())
                if (couponFeedback) setCouponFeedback(null)
              }}
              onPressEnter={(e) => {
                e.preventDefault()
                void handleApplyCoupon()
              }}
            />
            <Button
              type="primary"
              loading={couponBusy}
              disabled={busy || !couponInput.trim()}
              onClick={() => void handleApplyCoupon()}
            >
              应用
            </Button>
            <Button
              disabled={busy || couponBusy}
              onClick={() => {
                setCouponOpen(false)
                setCouponFeedback(null)
              }}
            >
              取消
            </Button>
          </Space.Compact>
        </div>
      ) : (
        <button
          type="button"
          className="checkout-coupon-trigger"
          disabled={busy}
          onClick={() => {
            setCouponFeedback(null)
            setCouponOpen(true)
          }}
        >
          <TagOutlined /> 有优惠码？点击输入立享差价
        </button>
      )}
      {couponFeedback && (
        <Alert className="mt-12" type={couponFeedback.type} showIcon title={couponFeedback.text} />
      )}
    </div>
  )

  return (
    <main className="container checkout-page">
      <FunnelView event="checkout_view" productId={product.id} />
      <Link href="/#plans" className="text-link">
        <ArrowLeftOutlined /> 返回套餐
      </Link>
      <div className="page-title">
        <h1>确认本次充值</h1>
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
              {couponSection}
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
              {couponSection}
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
                    checked={walletUsed > 0}
                    disabled={busy || !walletBalance}
                    onChange={(e) =>
                      setBalanceAmount(
                        e.target.checked ? Math.min(walletBalance ?? 0, payableAmount) : 0,
                      )
                    }
                  >
                    使用账户余额抵扣（
                    {walletBalance === null ? '余额暂未加载' : `可用 ${money(walletBalance)}`}）
                  </Checkbox>
                  {walletUsed > 0 && (
                    <Form.Item label="本次抵扣（元）" className="mt-20">
                      <InputNumber
                        disabled={busy}
                        aria-label="本次余额抵扣"
                        min={0}
                        max={Math.min(walletBalance ?? 0, payableAmount) / 100}
                        precision={2}
                        value={walletUsed / 100}
                        onChange={(v) => setBalanceAmount(Math.round((v ?? 0) * 100))}
                      />
                    </Form.Item>
                  )}
                </div>
              )}
              <div className="payment-breakdown">
                {discountAmount > 0 ? (
                  <>
                    <div>
                      <span>套餐原价</span>
                      <span className="muted">{money(quote.amount)}</span>
                    </div>
                    <div>
                      <span>优惠码（{coupon?.code}）</span>
                      <span className="coupon-saving-text">−{money(discountAmount)}</span>
                    </div>
                    <div>
                      <span>折后总价</span>
                      <span>{money(payableAmount)}</span>
                    </div>
                  </>
                ) : (
                  <div>
                    <span>订单总价</span>
                    <span>{money(quote.amount)}</span>
                  </div>
                )}
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
              <Button
                type="primary"
                size="large"
                block
                loading={busy}
                onClick={purchase}
                disabled={expired || !!limitError || paymentUnavailable || couponBusy}
              >
                {`确认订单 · ${money(payableAmount)}`} <ArrowRightOutlined />
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
            <div className="summary-price" aria-live="polite" aria-atomic="true">
              {!quote && product.priceStatus === 'pending' ? (
                '价格更新中'
              ) : discountAmount > 0 ? (
                <>
                  <div>
                    {money(payableAmount)}{' '}
                    <del className="price-original summary">
                      {money(quote ? quote.amount : product.price)}
                    </del>
                  </div>
                  <div className="summary-coupon-meta">
                    <span className="coupon-diff-badge">
                      已省 {money(discountAmount)}
                      {coupon?.code ? ` · ${coupon.code}` : ''}
                    </span>
                  </div>
                </>
              ) : (
                money(quote?.amount ?? product.price)
              )}
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
