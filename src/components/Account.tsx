'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  App,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
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
import { api, channels, dateTime, money, statuses } from '../lib'
import type { AccountData, Channel, Order, WalletEntry } from '../types'
import { PaymentOptions } from './Checkout'
import { paymentLimitError } from '../pricing'

export function Account({ section }: { section: 'orders' | 'wallet' | 'referral' }) {
  const { data, openLogin } = useSite()
  const { message } = App.useApp()
  const router = useRouter()
  const [account, setAccount] = useState<AccountData | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [topup, setTopup] = useState(false)
  const bot = useBotCheck('purchase', topup)
  const [withdraw, setWithdraw] = useState(false)
  const [amount, setAmount] = useState<number | null>(100)
  const [channel, setChannel] = useState<Channel>('alipay')
  const [busy, setBusy] = useState(false)
  const [requestKey, setRequestKey] = useState('')
  const [form] = Form.useForm()
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
    if (!amount) return
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
  async function requestWithdrawal(values: { amount: number; method: string; account: string }) {
    setBusy(true)
    try {
      await api('/wallet/withdraw', {
        ...values,
        amount: Math.round(values.amount * 100),
        requestKey,
      })
      setWithdraw(false)
      form.resetFields()
      await load()
      message.success('提现申请已提交')
    } catch (e) {
      message.error((e as Error).message)
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
          <div className="eyebrow">
            {section === 'orders'
              ? 'YOUR ORDERS'
              : section === 'wallet'
                ? 'YOUR WALLET'
                : 'BETTER TOGETHER'}
          </div>
          <h1>
            {section === 'orders'
              ? '每一笔订单，都有迹可循。'
              : section === 'wallet'
                ? '我的钱包'
                : '分享好用的，收获一点奖励。'}
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
                  onChange={setFilter}
                  items={[
                    { key: 'all', label: '全部订单' },
                    { key: 'unpaid', label: '待付款' },
                    { key: 'processing', label: '处理中' },
                    { key: 'completed', label: '已完成' },
                  ]}
                />
                <Input.Search
                  placeholder="搜索订单号或套餐"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  allowClear
                  style={{ maxWidth: 260 }}
                />
              </div>
              <Table<Order>
                rowKey="id"
                scroll={{ x: 760 }}
                locale={{ emptyText: <Empty description="还没有订单，去选一个适合的套餐吧" /> }}
                dataSource={account.orders.filter(
                  (o) =>
                    (filter === 'all' || o.status === filter) &&
                    `${o.id}${o.productName}`.toLowerCase().includes(search.toLowerCase()),
                )}
                pagination={{ pageSize: 8 }}
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
                    render: (v: Order['status']) => (
                      <Tag color={statuses[v].color}>{statuses[v].text}</Tag>
                    ),
                  },
                  { title: '时间', dataIndex: 'createdAt', render: dateTime },
                  {
                    title: '',
                    key: 'action',
                    render: (_, o) => (
                      <Link href={`/orders/${o.id}`}>
                        {o.status === 'unpaid' ? '继续付款' : '查看订单'} →
                      </Link>
                    ),
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
                    <WalletOutlined /> 可用余额
                  </div>
                  <div className="wallet-number">{money(account.balance)}</div>
                  <p>用于购买套餐，充值后到账</p>
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
                  <p className="muted">待结算 {money(account.pending)}</p>
                  <Button
                    disabled={account.available < data.settings.minimumWithdrawal}
                    onClick={() => {
                      setRequestKey(crypto.randomUUID())
                      setWithdraw(true)
                    }}
                  >
                    申请提现
                  </Button>
                </Card>
                <Card>
                  <span className="eyebrow">已完成提现</span>
                  <Statistic value={account.withdrawn / 100} precision={2} prefix="¥" />
                  <p className="muted">最低提现 {money(data.settings.minimumWithdrawal)}</p>
                  <Link href="/referral">查看邀请奖励 →</Link>
                </Card>
              </div>
              <Card>
                <Tabs
                  items={[
                    {
                      key: 'ledger',
                      label: '余额明细',
                      children: (
                        <Table<WalletEntry>
                          rowKey="id"
                          scroll={{ x: 560 }}
                          dataSource={account.ledger}
                          pagination={{ pageSize: 8 }}
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
                      ),
                    },
                    {
                      key: 'withdrawals',
                      label: '提现记录',
                      children: (
                        <Table
                          rowKey="id"
                          scroll={{ x: 580 }}
                          dataSource={account.withdrawals}
                          pagination={{ pageSize: 8 }}
                          columns={[
                            { title: '金额', dataIndex: 'amount', render: money },
                            { title: '方式', dataIndex: 'method' },
                            { title: '收款账号', dataIndex: 'account' },
                            {
                              title: '状态',
                              dataIndex: 'status',
                              render: (s: string) => (
                                <Tag
                                  color={
                                    s === 'paid'
                                      ? 'success'
                                      : s === 'rejected'
                                        ? 'error'
                                        : 'processing'
                                  }
                                >
                                  {{ pending: '审核中', paid: '已打款', rejected: '已拒绝' }[s]}
                                </Tag>
                              ),
                            },
                            { title: '说明', dataIndex: 'note' },
                            { title: '时间', dataIndex: 'createdAt', render: dateTime },
                          ]}
                        />
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
                  <Tag color="default">邀请奖励 {(data.settings.rateBps / 100).toFixed(0)}%</Tag>
                  <h2>你的专属邀请链接</h2>
                  <p>分享给朋友。符合规则的订单完成后，收益自动记入你的钱包。</p>
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
              <div className="stats-grid">
                <Card>
                  <Statistic title="已邀请好友" value={account.invitedCount} suffix="人" />
                </Card>
                <Card>
                  <Statistic
                    title="待结算收益"
                    value={account.pending / 100}
                    precision={2}
                    prefix="¥"
                  />
                </Card>
                <Card>
                  <Statistic
                    title="可提现收益"
                    value={Math.max(0, account.available) / 100}
                    precision={2}
                    prefix="¥"
                  />
                </Card>
              </div>
              <Card title="邀请奖励明细">
                <Table
                  rowKey="id"
                  scroll={{ x: 540 }}
                  dataSource={account.commissions}
                  pagination={{ pageSize: 8 }}
                  columns={[
                    {
                      title: '记录',
                      dataIndex: 'id',
                      render: (v: string) => <span className="mono">{v.slice(0, 16)}…</span>,
                    },
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
                          {{ pending: '待结算', available: '可提现', reversed: '已冲回' }[v]}
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
                    : '符合条件的成功交付套餐订单均参与返现。'}
                  按订单实付金额的 {data.settings.rateBps / 100}% 计算，结算期为{' '}
                  {data.settings.settlementDays}{' '}
                  天。钱包充值不产生返现，退款订单的对应奖励将被撤销。禁止自邀与循环交易。
                </p>
              </div>
            </>
          )}
        </>
      )}
      <Modal title="充值到我的钱包" open={topup} onCancel={() => setTopup(false)} footer={null}>
        <p className="muted">充值余额用于购买套餐，实际到账以服务端收款确认结果为准。</p>
        {bot.widget}
        <Form layout="vertical">
          <Form.Item label="充值金额（元）">
            <InputNumber
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
              allowBalance={false}
              amount={Math.round((amount ?? 0) * 100)}
            />
          </Form.Item>
          {data && amount && paymentLimitError(data.settings, channel, Math.round(amount * 100)) ? (
            <Alert
              className="mb-24"
              type="warning"
              title={paymentLimitError(data.settings, channel, Math.round(amount * 100))}
            />
          ) : null}
          <Button
            type="primary"
            block
            onClick={recharge}
            loading={busy}
            disabled={
              !amount ||
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
        onCancel={() => setWithdraw(false)}
        footer={null}
      >
        <p className="muted">
          可提现 {money(account?.available || 0)}，最低 {money(data.settings.minimumWithdrawal)}
          。提交后由管理员审核并打款。
        </p>
        <Form form={form} layout="vertical" onFinish={requestWithdrawal}>
          <Form.Item name="amount" label="提现金额（元）" rules={[{ required: true }]}>
            <InputNumber
              min={data.settings.minimumWithdrawal / 100}
              max={(account?.available || 0) / 100}
              precision={2}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="method" label="收款方式" rules={[{ required: true }]}>
            <Select
              options={['支付宝', '微信', 'USDT'].map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item
            name="account"
            label="收款账号 / 地址及网络"
            rules={[{ required: true, min: 3 }]}
          >
            <Input.TextArea rows={2} autoComplete="off" />
          </Form.Item>
          <Button htmlType="submit" type="primary" block loading={busy}>
            提交提现申请
          </Button>
        </Form>
      </Modal>
    </main>
  )
}
