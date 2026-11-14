'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Result,
  Select,
  Skeleton,
  Statistic,
  Table,
  Tabs,
  Tag,
} from 'antd'
import {
  CopyOutlined,
  GiftOutlined,
  PlusOutlined,
  WalletOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'
import { useBotCheck } from './BotCheck'
import { useSite } from './Providers'
import { api, channels, dateTime, money, orderStatusLabel } from '../lib'
import type { AccountData, Order, WalletEntry, Withdrawal, WithdrawalNetwork } from '../types'
import { PaymentOptions, usePaymentChannel } from './PaymentOptions'
import { useAccountHistory } from './useAccountHistory'
import { paymentLimitError } from '../pricing'
import { withdrawalStatuses } from '../referral'
import { ReferralLevels } from './ReferralLevels'
import {
  enabledWithdrawalMethods,
  lowestWithdrawalMinimum,
  usdtNetworks,
  usdtNetworkLabels,
  validUsdtAddress,
  withdrawalChannels,
  withdrawalFee,
  withdrawalRule,
} from '../withdrawals'

export function Account({ section }: { section: 'orders' | 'wallet' | 'referral' }) {
  const { data } = useSite()
  return <AccountContent key={data?.user?.id ?? 'guest'} section={section} />
}

function AccountContent({ section }: { section: 'orders' | 'wallet' | 'referral' }) {
  const { data, openLogin, refresh } = useSite()
  const { message } = App.useApp()
  const router = useRouter()
  const [account, setAccount] = useState<AccountData | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const orders = useAccountHistory<Order>(
    'orders',
    !!data?.user && section === 'orders',
    search,
    filter,
  )
  const ledger = useAccountHistory<WalletEntry>('ledger', !!data?.user && section === 'wallet')
  const [topup, setTopup] = useState(false)
  const bot = useBotCheck('purchase', topup)
  const [withdraw, setWithdraw] = useState(false)
  const [amount, setAmount] = useState<number | null>(100)
  const { channel, setChannel, paymentAvailable } = usePaymentChannel()
  const [busy, setBusy] = useState(false)
  const [requestKey, setRequestKey] = useState('')
  const [withdrawalError, setWithdrawalError] = useState('')
  const [form] = Form.useForm()
  const withdrawalMethod = Form.useWatch('method', form)
  const withdrawalNetwork = Form.useWatch('network', form) as WithdrawalNetwork | undefined
  const withdrawalAmount = Form.useWatch('amount', form) as number | undefined
  const configuredWithdrawals = withdrawalChannels(data?.settings ?? {})
  const availableMethods = enabledWithdrawalMethods(data?.settings ?? {})
  const availableNetworks = usdtNetworks.filter(
    (network) => configuredWithdrawals.networks[network],
  )
  const methodEnabled = availableMethods.some((option) => option.value === withdrawalMethod)
  const networkEnabled = !!withdrawalNetwork && availableNetworks.includes(withdrawalNetwork)
  const lowestMinimum = lowestWithdrawalMinimum(data?.settings ?? {})
  const selectedRule = withdrawalRule(data?.settings ?? {}, withdrawalMethod, withdrawalNetwork)
  const selectedMinimum = selectedRule?.minimum ?? null
  const withdrawalQuote =
    selectedRule && withdrawalAmount && withdrawalAmount > 0
      ? withdrawalFee(Math.round(withdrawalAmount * 100), selectedRule)
      : null
  const filteredOrders = orders.rows
  const orderAction = (order: Order) =>
    order.status === 'unpaid'
      ? '继续付款'
      : order.status === 'needs_session'
        ? '更新账号'
        : '查看订单'
  const ordersEmpty = (
    <Empty
      description={
        search.trim() || filter !== 'all'
          ? '没有符合当前搜索或状态的订单'
          : '还没有订单，去选一个适合的套餐吧'
      }
    >
      {search.trim() || filter !== 'all' ? (
        <Button
          onClick={() => {
            setSearch('')
            setFilter('all')
            orders.setPage(1)
          }}
        >
          清除筛选
        </Button>
      ) : (
        <Link href="/#plans" className="text-link">
          选择套餐 →
        </Link>
      )}
    </Empty>
  )
  useEffect(() => {
    if (!withdraw) return
    if (withdrawalMethod && !methodEnabled)
      form.setFieldsValue({
        method: undefined,
        network: undefined,
        account: undefined,
        confirmed: false,
      })
    else if (withdrawalNetwork && !networkEnabled)
      form.setFieldsValue({ network: undefined, account: undefined, confirmed: false })
  }, [withdraw, withdrawalMethod, withdrawalNetwork, methodEnabled, networkEnabled, form])
  useEffect(() => {
    if (!withdraw) return
    form.setFieldValue('confirmed', false)
    if (form.getFieldValue('amount') !== undefined)
      void form.validateFields(['amount']).catch(() => {})
  }, [withdraw, selectedMinimum, withdrawalQuote?.feeAmount, account?.available, form])
  const load = useCallback(async () => {
    try {
      setAccount(await api<AccountData>('/account'))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    if (data?.user) void load()
  }, [data?.user, load])
  const openTopup = () => {
    setRequestKey(crypto.randomUUID())
    setTopup(true)
  }
  async function recharge() {
    if (!amount || !paymentAvailable || busy) return
    if (data && paymentLimitError(data.settings, channel, Math.round(amount * 100))) return
    setBusy(true)
    try {
      const order = await api<Order>('/orders', {
        amount: Math.round(amount * 100),
        turnstileToken: bot.token(),
        channel,
        requestKey,
      })
      router.push(`/orders/${order.id}`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      bot.reset()
      setBusy(false)
    }
  }
  function openWithdrawal() {
    form.resetFields()
    const affordable = availableMethods.find(({ value }) =>
      value === 'USDT'
        ? availableNetworks.some(
            (network) => configuredWithdrawals.rules[network].minimum <= (account?.available ?? 0),
          )
        : withdrawalRule(data?.settings ?? {}, value)!.minimum <= (account?.available ?? 0),
    )
    form.setFieldValue('method', affordable?.value ?? availableMethods[0]?.value)
    setWithdrawalError('')
    setRequestKey(crypto.randomUUID())
    setWithdraw(true)
    void refresh()
  }
  async function requestWithdrawal(values: {
    amount: number
    method: string
    account: string
    recipientName: string
    network?: string
    confirmed: boolean
  }) {
    setBusy(true)
    setWithdrawalError('')
    try {
      await api('/wallet/withdraw', {
        ...values,
        amount: Math.round(values.amount * 100),
        expectedFeeAmount: withdrawalQuote?.feeAmount ?? 0,
        requestKey,
      })
      setWithdraw(false)
      form.resetFields()
      await load()
      message.success('提现申请已提交，对应邀请收益已冻结')
    } catch (e) {
      setWithdrawalError((e as Error).message)
      form.setFieldValue('confirmed', false)
      await Promise.all([load(), refresh()])
    } finally {
      setBusy(false)
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?ref=${data?.user?.referralCode}`,
      )
      message.success('邀请链接已复制')
    } catch {
      message.error('无法自动复制，请手动复制链接')
    }
  }
  if (!data)
    return (
      <main className="container page-content">
        <Skeleton active />
      </main>
    )
  if (!data.user)
    return (
      <main className="container page-content">
        <Result
          icon={section === 'referral' ? <GiftOutlined /> : <WalletOutlined />}
          title={section === 'referral' ? '分享好工具，收获邀请奖励' : '登录后，订单与钱包都在这里'}
          subTitle="邮箱验证码登录，新邮箱自动注册。"
          extra={
            <Button type="primary" onClick={() => openLogin(true)}>
              登录 / 注册
            </Button>
          }
        />
      </main>
    )
  return (
    <main className="container account-page">
      <div className="account-nav">
        <Link className={section === 'orders' ? 'active' : ''} href="/account">
          我的订单
        </Link>
        <Link className={section === 'wallet' ? 'active' : ''} href="/wallet">
          我的钱包
        </Link>
        <Link className={section === 'referral' ? 'active' : ''} href="/referral">
          邀请有礼
        </Link>
      </div>
      <div className="page-title title-with-action">
        <div>
          <h1>
            {section === 'orders' ? '我的订单' : section === 'wallet' ? '我的钱包' : '邀请有礼'}
          </h1>
          <p>
            {section === 'orders'
              ? '充值进度、付款记录，随时回来看看。'
              : section === 'wallet'
                ? '账户余额与邀请收益，清楚分开。'
                : '朋友完成购买后，符合规则的订单会为你带来收益。'}
          </p>
        </div>
        {section === 'orders' ? (
          <Link className="primary-link" href="/#plans">
            购买套餐 <PlusOutlined />
          </Link>
        ) : section === 'wallet' ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openTopup}>
            充值余额
          </Button>
        ) : null}
      </div>
      {error && <Alert title={error} type="error" action={<Button onClick={load}>重试</Button>} />}
      {!account ? (
        <Skeleton active />
      ) : (
        <>
          {section === 'orders' && (
            <Card>
              <div className="table-toolbar">
                <Tabs
                  activeKey={filter}
                  onChange={(value) => {
                    setFilter(value)
                    orders.setPage(1)
                  }}
                  items={[
                    { key: 'all', label: '全部订单' },
                    { key: 'unpaid', label: '待付款' },
                    { key: 'processing', label: '处理中' },
                    { key: 'completed', label: '已完成' },
                  ]}
                />
                <Input.Search
                  aria-label="搜索订单号或套餐"
                  placeholder="搜索订单号或套餐"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    orders.setPage(1)
                  }}
                  allowClear
                  style={{ maxWidth: 260 }}
                />
              </div>
              {orders.error && (
                <Alert
                  className="mb-24"
                  type="error"
                  title={orders.error}
                  action={<Button onClick={orders.retry}>重试</Button>}
                />
              )}
              <div className="mobile-orders">
                {orders.loading ? (
                  <Skeleton active />
                ) : filteredOrders.length ? (
                  <ul className="mobile-order-list">
                    {filteredOrders.map((order) => {
                      const status = orderStatusLabel(order)
                      return (
                        <li key={order.id} className="mobile-order">
                          <div className="mobile-order-heading">
                            <strong>{order.productName}</strong>
                            <Tag color={status.color}>{status.text}</Tag>
                          </div>
                          <p className="muted">
                            {order.kind === 'topup' ? '充值到本站钱包' : order.email}
                          </p>
                          <div className="mobile-order-meta">
                            <strong>{money(order.amount)}</strong>
                            <span className="tiny muted">{dateTime(order.createdAt)}</span>
                          </div>
                          <Link href={`/orders/${order.id}`} className="text-link">
                            {orderAction(order)} →
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  !orders.error && ordersEmpty
                )}
                <Pagination
                  simple
                  hideOnSinglePage
                  current={orders.page}
                  pageSize={8}
                  total={orders.total}
                  onChange={orders.setPage}
                />
              </div>
              <Table<Order>
                className="desktop-orders"
                loading={orders.loading}
                rowKey="id"
                scroll={{ x: 760 }}
                locale={{ emptyText: orders.error ? '订单暂未加载，请重试' : ordersEmpty }}
                dataSource={filteredOrders}
                pagination={{
                  pageSize: 8,
                  showSizeChanger: false,
                  current: orders.page,
                  total: orders.total,
                  onChange: orders.setPage,
                }}
                columns={[
                  {
                    title: '订单 / 套餐',
                    dataIndex: 'productName',
                    render: (_, o) => (
                      <div>
                        <strong>{o.productName}</strong>
                        <div className="tiny muted mono">{o.id.slice(0, 18)}…</div>
                      </div>
                    ),
                  },
                  { title: '账号', dataIndex: 'email' },
                  { title: '金额', dataIndex: 'amount', render: money },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (_: Order['status'], order: Order) => {
                      const status = orderStatusLabel(order)
                      return <Tag color={status.color}>{status.text}</Tag>
                    },
                  },
                  { title: '时间', dataIndex: 'createdAt', render: dateTime },
                  {
                    title: '操作',
                    key: 'action',
                    fixed: 'right',
                    width: 112,
                    render: (_, o) => <Link href={`/orders/${o.id}`}>{orderAction(o)} →</Link>,
                  },
                ]}
              />
            </Card>
          )}
          {section === 'wallet' && (
            <>
              <div className="wallet-cards">
                <Card className="wallet-primary">
                  <div className="wallet-label">
                    <WalletOutlined /> 消费余额
                  </div>
                  <div className="wallet-number">{money(account.balance)}</div>
                  <p>充值和退款余额仅用于购买套餐，不可提现</p>
                  <Button onClick={openTopup}>
                    充值余额 <ArrowRightOutlined />
                  </Button>
                </Card>
                <Card>
                  <span className="eyebrow">邀请收益</span>
                  <Statistic
                    title="可提现"
                    value={Math.max(0, account.available) / 100}
                    precision={2}
                    prefix="¥"
                  />
                  <p className="muted">
                    待结算 {money(account.pending)} · 提现冻结 {money(account.frozen)}
                  </p>
                  <Button
                    disabled={lowestMinimum === null || account.available < lowestMinimum}
                    onClick={openWithdrawal}
                  >
                    申请提现
                  </Button>
                  {lowestMinimum === null ? (
                    <p className="muted">提现渠道暂未开放，请稍后再试</p>
                  ) : (
                    account.available < lowestMinimum && (
                      <p className="muted">
                        再结算 {money(lowestMinimum - account.available)} 即可申请
                      </p>
                    )
                  )}
                </Card>
                <Card>
                  <span className="eyebrow">已完成提现</span>
                  <Statistic value={account.withdrawn / 100} precision={2} prefix="¥" />
                  <p className="muted">
                    {lowestMinimum === null
                      ? '提现渠道暂未开放'
                      : `已开放渠道 ${money(lowestMinimum)} 起提`}
                  </p>
                  <Link href="/referral">查看邀请奖励 →</Link>
                </Card>
              </div>
              <Alert
                className="mb-24"
                type={account.shortfall > 0 ? 'warning' : 'info'}
                showIcon
                title={
                  account.shortfall > 0 ? '邀请收益有冲回，提现暂不可用' : '提现额度只来自邀请收益'
                }
                description={
                  account.shortfall > 0
                    ? `冲回差额 ${money(account.shortfall)}。新的结算收益会先抵扣差额，申请中记录需由管理员核对。`
                    : `已结算 ${money(account.settled)} − 已提现 ${money(account.withdrawn)} − 提现冻结 ${money(account.frozen)} = 可提现 ${money(account.available)}。待结算、充值和退款余额不计入。`
                }
              />
              <Card>
                <Tabs
                  items={[
                    {
                      key: 'ledger',
                      label: '余额明细',
                      children: (
                        <>
                          {ledger.rows.length > 0 && (
                            <p className="mobile-table-hint tiny muted">
                              左右滑动可查看完整流水与关联订单。
                            </p>
                          )}
                          {ledger.error && (
                            <Alert
                              className="mb-24"
                              type="error"
                              title={ledger.error}
                              action={<Button onClick={ledger.retry}>重试</Button>}
                            />
                          )}
                          <Table<WalletEntry>
                            loading={ledger.loading}
                            rowKey="id"
                            scroll={{ x: 560 }}
                            dataSource={ledger.rows}
                            pagination={{
                              pageSize: 8,
                              showSizeChanger: false,
                              current: ledger.page,
                              total: ledger.total,
                              onChange: ledger.setPage,
                            }}
                            locale={{
                              emptyText: ledger.error
                                ? '余额明细暂未加载，请重试'
                                : '还没有余额变动，充值或使用余额后会显示在这里',
                            }}
                            columns={[
                              {
                                title: '类型',
                                dataIndex: 'kind',
                                render: (k: WalletEntry['kind']) =>
                                  ({ topup: '钱包充值', purchase: '余额付款', refund: '退款入账' })[
                                    k
                                  ],
                              },
                              {
                                title: '金额',
                                dataIndex: 'amount',
                                render: (n: number) => (
                                  <span className={n > 0 ? 'income' : ''}>
                                    {n > 0 ? '+' : ''}
                                    {money(n)}
                                  </span>
                                ),
                              },
                              { title: '变动后余额', dataIndex: 'balanceAfter', render: money },
                              { title: '时间', dataIndex: 'createdAt', render: dateTime },
                              {
                                title: '关联订单',
                                dataIndex: 'orderId',
                                render: (id: string) => (
                                  <Link href={`/orders/${id}`}>查看订单 →</Link>
                                ),
                              },
                            ]}
                          />
                        </>
                      ),
                    },
                    {
                      key: 'withdrawals',
                      label: '提现记录',
                      children: (
                        <>
                          {account.withdrawals.length > 0 && (
                            <p className="mobile-table-hint tiny muted">
                              左右滑动可查看完整收款信息与处理说明。
                            </p>
                          )}
                          <Table<Withdrawal>
                            rowKey="id"
                            scroll={{ x: 580 }}
                            dataSource={account.withdrawals}
                            pagination={{ pageSize: 8 }}
                            columns={[
                              {
                                title: '申请单',
                                dataIndex: 'id',
                                render: (id: string) => <span className="mono tiny">{id}</span>,
                              },
                              { title: '申请金额', dataIndex: 'amount', render: money },
                              { title: '手续费', dataIndex: 'feeAmount', render: money },
                              { title: '净额（元）', dataIndex: 'netAmount', render: money },
                              {
                                title: '方式',
                                key: 'method',
                                render: (_, w) =>
                                  `${w.method}${w.network ? ` · ${usdtNetworkLabels[w.network]}` : ''}`,
                              },
                              {
                                title: '收款人',
                                dataIndex: 'recipientName',
                                render: (name: string) => name || '—',
                              },
                              { title: '收款账号', dataIndex: 'account' },
                              {
                                title: '状态',
                                dataIndex: 'status',
                                render: (s: Withdrawal['status']) => (
                                  <Tag color={withdrawalStatuses[s].color}>
                                    {withdrawalStatuses[s].text}
                                  </Tag>
                                ),
                              },
                              {
                                title: '实际打款',
                                key: 'payout',
                                render: (_, w) =>
                                  w.payoutAmount
                                    ? `${Number(w.payoutAmount)} ${w.method === 'USDT' ? 'USDT' : 'CNY'}`
                                    : '—',
                              },
                              {
                                title: '打款流水号',
                                dataIndex: 'payoutReference',
                                render: (value: string) => value || '—',
                              },
                              { title: '说明', dataIndex: 'note' },
                              { title: '时间', dataIndex: 'createdAt', render: dateTime },
                            ]}
                          />
                        </>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          )}
          {section === 'referral' && (
            <>
              <div className="referral-dashboard">
                <div className="referral-main">
                  <Tag color="default">
                    {account.referral.current.name} · 邀请奖励{' '}
                    {account.referral.current.rateBps / 100}%
                  </Tag>
                  <h2>你的专属邀请链接</h2>
                  <p>分享给朋友。符合规则的订单完成后，收益进入结算期，结算后可申请提现。</p>
                  <div className="invite-link">
                    <code>
                      {typeof window !== 'undefined' ? window.location.origin : ''}/?ref=
                      {data.user.referralCode}
                    </code>
                    <Button type="primary" icon={<CopyOutlined />} onClick={copy}>
                      复制链接
                    </Button>
                  </div>
                  <span className="tiny muted">
                    支持游客购买。下单时记录邀请关系，充值完成后计入返现；登录认领不会重复返现。
                  </span>
                </div>
                <div className="referral-decoration">✧</div>
              </div>
              <ReferralLevels referral={account.referral} />
              <div className="stats-grid">
                <Card>
                  <Statistic
                    title="有效邀请"
                    value={account.referral.qualifiedInvites}
                    suffix="人"
                  />
                  <p className="tiny muted">
                    已绑定注册好友 {account.invitedCount} 人；有效邀请含游客
                  </p>
                </Card>
                <Card>
                  <Statistic
                    title="待结算收益"
                    value={account.pending / 100}
                    precision={2}
                    prefix="¥"
                  />
                  <p className="tiny muted">结算后才可用于提现</p>
                </Card>
                <Card>
                  <Statistic
                    title="可提现收益"
                    value={Math.max(0, account.available) / 100}
                    precision={2}
                    prefix="¥"
                  />
                  <p className="tiny muted">提现冻结 {money(account.frozen)}</p>
                  <Button
                    onClick={openWithdrawal}
                    disabled={lowestMinimum === null || account.available < lowestMinimum}
                  >
                    申请提现
                  </Button>
                  {!availableMethods.length && (
                    <p className="tiny muted">提现渠道暂未开放，请稍后再试</p>
                  )}
                </Card>
              </div>
              <Card title="邀请奖励明细">
                <Table
                  rowKey="id"
                  scroll={{ x: 540 }}
                  dataSource={account.commissions}
                  pagination={{ pageSize: 8 }}
                  columns={[
                    { title: '奖励', dataIndex: 'amount', render: money },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      render: (v: string) => (
                        <Tag
                          color={
                            v === 'available'
                              ? 'success'
                              : v === 'reversed'
                                ? 'default'
                                : 'processing'
                          }
                        >
                          {{ pending: '待结算', available: '已结算', reversed: '已冲回' }[v]}
                        </Tag>
                      ),
                    },
                    { title: '预计结算时间', dataIndex: 'availableAt', render: dateTime },
                  ]}
                />
              </Card>
              <div className="rules-note">
                <h3>奖励规则</h3>
                <p>
                  {data.settings.firstOrderOnly
                    ? '仅好友首笔成功交付的套餐订单参与返现。'
                    : '好友每笔符合条件的成功交付套餐订单均参与返现，复购也有奖励。'}
                  按下单时邀请等级对应比例计算（当前 {account.referral.current.rateBps / 100}
                  %），结算期为 {data.settings.settlementDays}{' '}
                  天。各提现渠道的最低起提金额与手续费以申请表展示为准。
                  钱包充值不产生返现，退款订单的对应奖励将被撤销。
                  只奖励直接邀请，不计算好友继续邀请他人的订单。禁止自邀与循环交易。
                </p>
              </div>
            </>
          )}
        </>
      )}
      <Modal
        title="充值到我的钱包"
        open={topup}
        onCancel={() => {
          if (!busy) setTopup(false)
        }}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        footer={null}
      >
        <p className="muted">充值余额用于购买套餐，实际到账以服务端收款确认结果为准。</p>
        {bot.widget}
        <Form layout="vertical" disabled={busy} onFinish={recharge}>
          <Form.Item label="充值金额（元）" htmlFor="wallet-topup-amount">
            <InputNumber
              id="wallet-topup-amount"
              min={1}
              max={10000}
              precision={2}
              value={amount}
              onChange={(v) => setAmount(v)}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="支付方式">
            <PaymentOptions
              value={channel}
              onChange={setChannel}
              disabled={busy}
              amount={Math.round((amount ?? 0) * 100)}
            />
          </Form.Item>
          {paymentAvailable &&
          data &&
          amount &&
          paymentLimitError(data.settings, channel, Math.round(amount * 100)) ? (
            <Alert
              className="mb-24"
              type="warning"
              title={paymentLimitError(data.settings, channel, Math.round(amount * 100))}
            />
          ) : null}
          <Button
            type="primary"
            block
            htmlType="submit"
            loading={busy}
            disabled={
              !amount ||
              !paymentAvailable ||
              !!(data && paymentLimitError(data.settings, channel, Math.round((amount ?? 0) * 100)))
            }
          >
            创建充值订单
          </Button>
        </Form>
      </Modal>
      <Modal
        title="申请邀请收益提现"
        open={withdraw}
        onCancel={() => {
          if (!busy) setWithdraw(false)
        }}
        closable={!busy}
        mask={{ closable: !busy }}
        footer={null}
        width={560}
      >
        <div className="withdrawal-summary">
          <span>本次最多可提现</span>
          <strong>{money(account?.available || 0)}</strong>
          <p>
            已扣除申请中冻结 {money(account?.frozen || 0)}
            {selectedMinimum !== null
              ? ` · 最低起提 ${money(selectedMinimum)}`
              : ' · 选择收款方式及网络后显示起提金额'}
          </p>
        </div>
        <p className="muted">仅限已结算邀请收益。充值和退款余额仅可消费。</p>
        {!availableMethods.length && (
          <Alert className="mb-24" type="info" showIcon title="提现渠道暂未开放，请稍后再试" />
        )}
        {withdrawalError && (
          <Alert className="mb-24" type="error" showIcon title={withdrawalError} />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={requestWithdrawal}
          onValuesChange={(changed) => {
            if (!('confirmed' in changed)) form.setFieldValue('confirmed', false)
          }}
          disabled={busy}
          scrollToFirstError
        >
          <Form.Item name="method" label="收款方式" rules={[{ required: true }]}>
            <Select
              virtual={false}
              placeholder="选择已开放的收款方式"
              options={availableMethods.map(({ value, label }) => ({ value, label }))}
              onChange={() => form.resetFields(['account', 'network', 'confirmed'])}
            />
          </Form.Item>
          {withdrawalMethod === 'USDT' && (
            <Form.Item
              name="network"
              label="收款网络"
              preserve={false}
              rules={[{ required: true, message: '请选择收款地址对应的网络' }]}
            >
              <Select
                virtual={false}
                placeholder="选择地址对应的网络"
                options={availableNetworks.map((value) => ({
                  value,
                  label: usdtNetworkLabels[value],
                }))}
                onChange={() => form.resetFields(['account', 'confirmed'])}
              />
            </Form.Item>
          )}
          <Form.Item label="提现金额（元）" required>
            <div className="withdrawal-amount">
              <Form.Item
                name="amount"
                noStyle
                dependencies={['method', 'network']}
                rules={[
                  { required: true, message: '请输入提现金额' },
                  {
                    validator: (_, value: number | undefined) => {
                      if (value === undefined || value === null) return Promise.resolve()
                      const cents = Math.round(value * 100)
                      const rule = withdrawalRule(
                        data.settings,
                        form.getFieldValue('method'),
                        form.getFieldValue('network'),
                      )
                      if (rule && cents < rule.minimum)
                        return Promise.reject(
                          new Error(`所选提现渠道最低起提 ${money(rule.minimum)}`),
                        )
                      if (cents <= 0 || cents > (account?.available || 0))
                        return Promise.reject(
                          new Error(`本次最多可提现 ${money(account?.available || 0)}`),
                        )
                      return Promise.resolve()
                    },
                  },
                ]}
              >
                <InputNumber
                  aria-label="提现金额（元）"
                  min={(selectedMinimum ?? 1) / 100}
                  max={(account?.available || 0) / 100}
                  precision={2}
                  step={0.01}
                  placeholder="输入本次提现金额"
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Button
                disabled={selectedMinimum !== null && (account?.available || 0) < selectedMinimum}
                onClick={() => form.setFieldValue('amount', (account?.available || 0) / 100)}
              >
                全部提现
              </Button>
            </div>
          </Form.Item>
          <Form.Item
            name="recipientName"
            label="收款人姓名"
            extra="填写收款账户对应的姓名，供人工核对。"
            rules={[
              {
                required: true,
                whitespace: true,
                min: 2,
                max: 80,
                message: '请填写收款人姓名（2–80 个字）',
              },
            ]}
          >
            <Input autoComplete="name" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="account"
            label={
              withdrawalMethod === 'USDT' ? 'USDT 收款地址' : `${withdrawalMethod || ''}收款账号`
            }
            extra={
              withdrawalMethod === 'USDT'
                ? '请确认收款平台支持所选网络及对应的 USDT 资产。同一个 0x 地址不能用来判断收款网络。'
                : undefined
            }
            dependencies={['network', 'method']}
            rules={[
              { required: true, whitespace: true, min: 3, max: 250, message: '请填写完整收款账号' },
              {
                validator: (_, value: string) => {
                  if (withdrawalMethod !== 'USDT' || !value || !withdrawalNetwork)
                    return Promise.resolve()
                  return validUsdtAddress(withdrawalNetwork, value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('地址与所选网络格式不匹配，请核对'))
                },
              },
            ]}
          >
            <Input
              autoComplete="off"
              maxLength={250}
              placeholder={
                withdrawalMethod === 'USDT'
                  ? '粘贴完整钱包地址'
                  : withdrawalMethod === '微信'
                    ? '填写可联系收款的微信号'
                    : '支付宝绑定的手机号或邮箱'
              }
            />
          </Form.Item>
          {withdrawalMethod === 'USDT' && (
            <Alert
              className="mb-24"
              type="info"
              showIcon
              title="申请金额以人民币计"
              description="客服会按扣除手续费后的人民币净额与你确认折算数量，再人工转账。实际到账 USDT 数量与交易哈希将记入提现记录。"
            />
          )}
          <div className="withdrawal-review">
            <span>本次冻结邀请收益</span>
            <strong>{money(Math.round((withdrawalAmount || 0) * 100))}</strong>
          </div>
          <div className="withdrawal-review">
            <span>
              提现手续费
              {selectedRule
                ? `（${selectedRule.feeRateBps / 100}% + ${money(selectedRule.fixedFee)}）`
                : ''}
            </span>
            <strong data-testid="withdrawal-fee">
              {withdrawalQuote ? money(withdrawalQuote.feeAmount) : '—'}
            </strong>
          </div>
          <div className="withdrawal-review">
            <span>{withdrawalMethod === 'USDT' ? '待折算净额（人民币）' : '预计到账'}</span>
            <strong data-testid="withdrawal-net">
              {withdrawalQuote ? money(Math.max(0, withdrawalQuote.netAmount)) : '—'}
            </strong>
          </div>
          <Form.Item
            name="confirmed"
            valuePropName="checked"
            rules={[
              {
                validator: (_, value) =>
                  value ? Promise.resolve() : Promise.reject(new Error('请核对并确认收款信息')),
              },
            ]}
          >
            <Checkbox>
              我已核对收款信息、手续费与到账金额，确认提交后冻结对应邀请收益，审核拒绝后全额释放。
            </Checkbox>
          </Form.Item>
          <Button
            htmlType="submit"
            type="primary"
            block
            loading={busy}
            disabled={
              !methodEnabled ||
              (withdrawalMethod === 'USDT' && !networkEnabled) ||
              (selectedMinimum !== null && (account?.available || 0) < selectedMinimum) ||
              (withdrawalQuote !== null && withdrawalQuote.netAmount <= 0)
            }
          >
            确认并提交提现申请
          </Button>
          <p className="tiny muted withdrawal-footnote">
            提交后可在「我的钱包 → 提现记录」查看进度。实际到账以人工打款结果为准。
          </p>
        </Form>
      </Modal>
    </main>
  )
}
