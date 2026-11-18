'use client'
import { useEffect, useState } from 'react'
import {
  App,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd'
import { CopyOutlined, DownOutlined } from '@ant-design/icons'
import type { AdminCoupon, Product } from '../types'
import { api, dateTime, money } from '../lib'
import { formatCouponBenefit, formatCouponScope } from '../coupons'

function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocal(local: string | null | undefined): string | null {
  if (!local || !local.trim()) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function randomCouponCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'VIP'
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

interface CouponFormValues {
  code: string
  name: string
  note: string
  discountKind: 'fixed' | 'percent'
  fixedYuan?: number
  percentOff?: number
  maxDiscountYuan?: number | null
  minAmountYuan?: number | null
  scopeMode: 'all' | 'recharge_only' | 'upgrade_only' | 'products'
  productIds?: string[]
  upgradeProtection: 'cost' | 'min_profit' | 'none'
  firstOrderOnly: boolean
  requireLogin: boolean
  maxRedemptions?: number | null
  perBuyerLimit?: number | null
  startsAtLocal?: string
  expiresAtLocal?: string
  allowReferral: boolean
  affiliateEmail?: string
  affiliateRatePercent?: number | null
  enabled: boolean
}

export function CouponManager({
  coupons,
  products,
  canWrite,
  loading,
  search,
  onSearchChange,
  pagination,
  createSignal,
  onChanged,
}: {
  coupons: AdminCoupon[]
  products: Product[]
  canWrite: boolean
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  pagination: {
    current: number
    pageSize: number
    total: number
    showSizeChanger: boolean
    showTotal: (total: number) => string
    onChange: (page: number) => void
  }
  createSignal: number
  onChanged: () => Promise<void>
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<CouponFormValues>()
  const [editing, setEditing] = useState<AdminCoupon | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const discountKind = Form.useWatch('discountKind', form) ?? 'fixed'
  const scopeMode = Form.useWatch('scopeMode', form) ?? 'all'
  const affiliateEmailWatch = Form.useWatch('affiliateEmail', form) ?? ''

  const openModal = (coupon?: AdminCoupon) => {
    setEditing(coupon ?? null)
    form.resetFields()
    if (coupon) {
      form.setFieldsValue({
        code: coupon.code,
        name: coupon.name,
        note: coupon.note,
        discountKind: coupon.discountKind,
        fixedYuan: coupon.discountKind === 'fixed' ? coupon.discountValue / 100 : 20,
        percentOff: coupon.discountKind === 'percent' ? coupon.discountValue / 100 : 10,
        maxDiscountYuan: coupon.maxDiscountAmount !== null ? coupon.maxDiscountAmount / 100 : null,
        minAmountYuan: coupon.minAmount / 100,
        scopeMode: coupon.scopeMode,
        productIds: coupon.productIds,
        upgradeProtection: coupon.upgradeProtection,
        firstOrderOnly: coupon.firstOrderOnly,
        requireLogin: coupon.requireLogin,
        maxRedemptions: coupon.maxRedemptions,
        perBuyerLimit: coupon.perBuyerLimit,
        startsAtLocal: toDatetimeLocal(coupon.startsAt),
        expiresAtLocal: toDatetimeLocal(coupon.expiresAt),
        allowReferral: coupon.allowReferral,
        affiliateEmail: coupon.affiliateEmail ?? '',
        affiliateRatePercent:
          coupon.affiliateRateBps !== null ? coupon.affiliateRateBps / 100 : null,
        enabled: coupon.enabled,
      })
    } else {
      form.setFieldsValue({
        code: randomCouponCode(),
        name: '',
        note: '',
        discountKind: 'fixed',
        fixedYuan: 20,
        percentOff: 10,
        maxDiscountYuan: null,
        minAmountYuan: 0,
        scopeMode: 'all',
        productIds: [],
        upgradeProtection: 'cost',
        firstOrderOnly: false,
        requireLogin: false,
        maxRedemptions: null,
        perBuyerLimit: 1,
        startsAtLocal: '',
        expiresAtLocal: '',
        allowReferral: true,
        affiliateEmail: '',
        affiliateRatePercent: null,
        enabled: true,
      })
    }
    setOpen(true)
  }

  useEffect(() => {
    if (createSignal > 0 && canWrite) {
      openModal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal])

  async function save(values: CouponFormValues) {
    setBusy(true)
    try {
      const affiliateEmail = values.affiliateEmail?.trim().toLowerCase() || null
      const payload = {
        ...(editing ? { id: editing.id } : {}),
        code: values.code.trim().toUpperCase(),
        name: values.name.trim(),
        note: values.note?.trim() ?? '',
        discountKind: values.discountKind,
        discountValue:
          values.discountKind === 'fixed'
            ? Math.round((values.fixedYuan ?? 0) * 100)
            : Math.round((values.percentOff ?? 0) * 100),
        maxDiscountAmount:
          values.discountKind === 'percent' &&
          values.maxDiscountYuan !== null &&
          values.maxDiscountYuan !== undefined &&
          values.maxDiscountYuan > 0
            ? Math.round(values.maxDiscountYuan * 100)
            : null,
        minAmount: Math.round((values.minAmountYuan ?? 0) * 100),
        scopeMode: values.scopeMode,
        productIds: values.scopeMode === 'products' ? (values.productIds ?? []) : [],
        upgradeProtection: values.upgradeProtection,
        firstOrderOnly: Boolean(values.firstOrderOnly),
        requireLogin: Boolean(values.requireLogin),
        maxRedemptions:
          values.maxRedemptions !== null &&
          values.maxRedemptions !== undefined &&
          values.maxRedemptions > 0
            ? Math.round(values.maxRedemptions)
            : null,
        perBuyerLimit:
          values.perBuyerLimit !== null &&
          values.perBuyerLimit !== undefined &&
          values.perBuyerLimit > 0
            ? Math.round(values.perBuyerLimit)
            : null,
        startsAt: fromDatetimeLocal(values.startsAtLocal),
        expiresAt: fromDatetimeLocal(values.expiresAtLocal),
        allowReferral: Boolean(values.allowReferral),
        affiliateEmail,
        affiliateRateBps:
          affiliateEmail &&
          values.affiliateRatePercent !== null &&
          values.affiliateRatePercent !== undefined
            ? Math.round(values.affiliateRatePercent * 100)
            : null,
        enabled: Boolean(values.enabled),
      }
      await api('/admin/coupons', payload)
      setOpen(false)
      await onChanged()
      message.success(editing ? '优惠码已更新' : '优惠码已创建')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled(coupon: AdminCoupon) {
    setBusy(true)
    try {
      await api('/admin/coupons', {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        note: coupon.note,
        discountKind: coupon.discountKind,
        discountValue: coupon.discountValue,
        maxDiscountAmount: coupon.maxDiscountAmount,
        minAmount: coupon.minAmount,
        scopeMode: coupon.scopeMode,
        productIds: coupon.productIds,
        upgradeProtection: coupon.upgradeProtection,
        firstOrderOnly: coupon.firstOrderOnly,
        requireLogin: coupon.requireLogin,
        maxRedemptions: coupon.maxRedemptions,
        perBuyerLimit: coupon.perBuyerLimit,
        startsAt: coupon.startsAt,
        expiresAt: coupon.expiresAt,
        allowReferral: coupon.allowReferral,
        affiliateEmail: coupon.affiliateEmail,
        affiliateRateBps: coupon.affiliateRateBps,
        enabled: !coupon.enabled,
      })
      await onChanged()
      message.success(coupon.enabled ? '优惠码已停用' : '优惠码已启用')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copyUrl(pathWithQuery: string, label: string) {
    const url = `${window.location.origin}${pathWithQuery}`
    try {
      await navigator.clipboard.writeText(url)
      message.success(`已复制${label}：${url}`)
    } catch {
      message.error('无法自动复制，请手动复制')
    }
  }

  const nowMs = Date.now()
  const activeOnPage = coupons.filter((c) => c.enabled).length
  const redeemedOnPage = coupons.reduce((sum, c) => sum + c.redeemedCount, 0)
  const discountOnPage = coupons.reduce((sum, c) => sum + c.totalDiscountAmount, 0)

  return (
    <>
      <Card>
        <div className="inventory-toolbar">
          <div className="inventory-status-summary" style={{ marginBottom: 0 }}>
            <span>
              本页启用<strong>{activeOnPage}</strong>
            </span>
            <span>
              本页已核销<strong>{redeemedOnPage}</strong>
            </span>
            <span>
              本页累计让利<strong>{money(discountOnPage)}</strong>
            </span>
          </div>
          <Space wrap>
            <Input.Search
              aria-label="搜索优惠码、名称或推广员邮箱"
              placeholder="搜索优惠码 / 名称 / 推广员"
              value={search}
              allowClear
              onChange={(e) => onSearchChange(e.target.value)}
              style={{ width: 260 }}
            />
          </Space>
        </div>

        <Table<AdminCoupon>
          rowKey="id"
          dataSource={coupons}
          loading={loading}
          scroll={{ x: 1180 }}
          pagination={pagination}
          locale={{ emptyText: search ? '未找到匹配的优惠码' : '暂未创建优惠码' }}
          columns={[
            {
              title: '优惠码 / 名称',
              key: 'code',
              width: 210,
              render: (_, c) => (
                <div>
                  <div>
                    <code className="coupon-code-chip">{c.code}</code>
                  </div>
                  <strong style={{ display: 'block', marginTop: 6 }}>{c.name}</strong>
                  {c.note && <div className="tiny muted">{c.note}</div>}
                </div>
              ),
            },
            {
              title: '优惠力度',
              key: 'benefit',
              width: 170,
              render: (_, c) => (
                <div>
                  <Tag color="warning">{formatCouponBenefit(c)}</Tag>
                  {c.minAmount > 0 && (
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      满 {money(c.minAmount)} 可用
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: '适用范围与规则',
              key: 'scope',
              width: 230,
              render: (_, c) => {
                const productNames =
                  c.scopeMode === 'products'
                    ? products.filter((p) => c.productIds.includes(p.id)).map((p) => p.name)
                    : undefined
                return (
                  <div>
                    <div>{formatCouponScope({ scopeMode: c.scopeMode }, productNames)}</div>
                    <Space wrap size={[4, 4]} style={{ marginTop: 6 }}>
                      {c.firstOrderOnly && <Tag>仅首单</Tag>}
                      {c.requireLogin && <Tag>需登录</Tag>}
                      {!c.allowReferral && !c.affiliateEmail && <Tag>不叠邀请返现</Tag>}
                    </Space>
                  </div>
                )
              },
            },
            {
              title: '推广员归因',
              key: 'affiliate',
              width: 190,
              render: (_, c) =>
                c.affiliateEmail ? (
                  <div>
                    <div className="wrap-anywhere">{c.affiliateEmail}</div>
                    <div className="tiny muted">
                      {c.affiliateRateBps !== null
                        ? `专属返佣 ${c.affiliateRateBps / 100}%`
                        : '按推广员当前等级返佣'}
                    </div>
                  </div>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              title: '核销 / 名额',
              key: 'usage',
              width: 140,
              render: (_, c) => (
                <div>
                  <div>
                    <strong>{c.redeemedCount}</strong>
                    <span className="muted">
                      {' '}
                      / {c.maxRedemptions !== null ? c.maxRedemptions : '不限'}
                    </span>
                  </div>
                  {c.reservedCount > 0 && (
                    <div className="tiny muted">待付款锁定 {c.reservedCount}</div>
                  )}
                  {c.perBuyerLimit !== null && (
                    <div className="tiny muted">每人限 {c.perBuyerLimit} 次</div>
                  )}
                </div>
              ),
            },
            {
              title: '让利 / 带动成交',
              key: 'revenue',
              width: 160,
              render: (_, c) => (
                <div>
                  <div>让利 {money(c.totalDiscountAmount)}</div>
                  <div className="tiny muted">实付 {money(c.totalOrderAmount)}</div>
                </div>
              ),
            },
            {
              title: '状态与有效期',
              key: 'status',
              width: 170,
              render: (_, c) => {
                const expired = c.expiresAt ? Date.parse(c.expiresAt) <= nowMs : false
                const notStarted = c.startsAt ? Date.parse(c.startsAt) > nowMs : false
                const exhausted =
                  c.maxRedemptions !== null && c.redeemedCount + c.reservedCount >= c.maxRedemptions
                const status = !c.enabled
                  ? { color: 'default' as const, text: '已停用' }
                  : expired
                    ? { color: 'default' as const, text: '已过期' }
                    : notStarted
                      ? { color: 'processing' as const, text: '未开始' }
                      : exhausted
                        ? { color: 'warning' as const, text: '名额已满' }
                        : { color: 'success' as const, text: '生效中' }
                return (
                  <div>
                    <Tag color={status.color}>{status.text}</Tag>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {c.expiresAt ? `至 ${dateTime(c.expiresAt)}` : '长期有效'}
                    </div>
                  </div>
                )
              },
            },
            {
              title: '操作',
              key: 'actions',
              fixed: 'right',
              width: 210,
              render: (_, c) => {
                const linkItems = [
                  {
                    key: 'home',
                    label: '复制首页带券链接',
                    onClick: () => void copyUrl(`/?coupon=${c.code}`, '首页带券链接'),
                  },
                  {
                    key: 'compare',
                    label: '复制对比页带券链接',
                    onClick: () => void copyUrl(`/compare?coupon=${c.code}`, '对比页带券链接'),
                  },
                  ...products
                    .filter((p) => p.enabled)
                    .slice(0, 6)
                    .map((p) => ({
                      key: `checkout:${p.id}`,
                      label: `直达结算：${p.name}`,
                      onClick: () =>
                        void copyUrl(
                          `/checkout?product=${p.id}&coupon=${c.code}`,
                          `${p.name}带券结算链接`,
                        ),
                    })),
                ]
                return (
                  <Space wrap size={4}>
                    <Dropdown menu={{ items: linkItems }} trigger={['click']}>
                      <Button type="link" size="small" icon={<CopyOutlined />}>
                        推广链接 <DownOutlined />
                      </Button>
                    </Dropdown>
                    {canWrite && (
                      <>
                        <Button type="link" size="small" onClick={() => openModal(c)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title={c.enabled ? '停用此优惠码？' : '重新启用此优惠码？'}
                          onConfirm={() => void toggleEnabled(c)}
                        >
                          <Button type="link" size="small" danger={c.enabled} disabled={busy}>
                            {c.enabled ? '停用' : '启用'}
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                )
              },
            },
          ]}
        />
      </Card>

      <Modal
        forceRender
        title={editing ? `编辑优惠码 · ${editing.code}` : '新增优惠码'}
        open={open}
        onCancel={() => {
          if (!busy) setOpen(false)
        }}
        footer={null}
        width={640}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void save(values)}
          disabled={busy}
        >
          <div className="form-two">
            <Form.Item label="优惠码（自动大写）" required>
              <Space.Compact block>
                <Form.Item
                  name="code"
                  noStyle
                  rules={[
                    { required: true, message: '请输入优惠码' },
                    {
                      pattern: /^[A-Za-z0-9_-]{3,32}$/,
                      message: '3–32 位字母、数字、下划线或连字符',
                    },
                  ]}
                >
                  <Input
                    aria-label="优惠码编码"
                    placeholder="PLUS20"
                    maxLength={32}
                    onChange={(e) => form.setFieldValue('code', e.target.value.toUpperCase())}
                  />
                </Form.Item>
                {!editing && (
                  <Button onClick={() => form.setFieldValue('code', randomCouponCode())}>
                    随机
                  </Button>
                )}
              </Space.Compact>
            </Form.Item>
            <Form.Item
              name="name"
              label="活动名称"
              rules={[{ required: true, whitespace: true, message: '请填写活动名称' }]}
            >
              <Input aria-label="活动名称" placeholder="例如：春季 Plus 立减券" maxLength={80} />
            </Form.Item>
          </div>

          <div className="form-three">
            <Form.Item name="discountKind" label="优惠类型" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'fixed', label: '固定金额立减' },
                  { value: 'percent', label: '百分比折扣' },
                ]}
              />
            </Form.Item>
            {discountKind === 'fixed' ? (
              <Form.Item
                name="fixedYuan"
                label="立减金额（元）"
                rules={[{ required: true, message: '请填写立减金额' }]}
              >
                <InputNumber
                  aria-label="立减金额（元）"
                  min={0.01}
                  max={100000}
                  precision={2}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="percentOff"
                  label="减免比例（%）"
                  extra="如填 15 表示立减 15%（8.5 折）"
                  rules={[{ required: true, message: '请填写减免比例' }]}
                >
                  <InputNumber
                    aria-label="减免比例（%）"
                    min={0.01}
                    max={99}
                    precision={2}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                <Form.Item name="maxDiscountYuan" label="最高减免封顶（元）" extra="留空表示不封顶">
                  <InputNumber
                    min={0.01}
                    max={100000}
                    precision={2}
                    placeholder="不封顶"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </>
            )}
            <Form.Item name="minAmountYuan" label="最低订单门槛（元）" extra="0 表示无门槛">
              <InputNumber min={0} max={100000} precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <div className="form-two">
            <Form.Item name="scopeMode" label="适用套餐范围" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'all', label: '全站充值套餐通用' },
                  { value: 'recharge_only', label: '仅普通直充套餐' },
                  { value: 'products', label: '指定具体套餐' },
                ]}
              />
            </Form.Item>
          </div>

          {scopeMode === 'products' && (
            <Form.Item
              name="productIds"
              label="选择适用套餐"
              rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一个套餐' }]}
            >
              <Select
                mode="multiple"
                placeholder="选择一个或多个套餐"
                options={products.map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
              />
            </Form.Item>
          )}

          <div className="form-two">
            <Form.Item
              name="maxRedemptions"
              label="总发行名额"
              extra="留空表示不限总次数；并发下单自动行锁防超卖"
            >
              <InputNumber
                min={1}
                max={10000000}
                precision={0}
                placeholder="不限总名额"
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item
              name="perBuyerLimit"
              label="单买家限领次数"
              extra="按登录账号、联系邮箱、目标充值账号联合识别；留空不限"
            >
              <InputNumber
                min={1}
                max={10000}
                precision={0}
                placeholder="不限单人次数"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </div>

          <div className="form-two">
            <Form.Item name="startsAtLocal" label="生效开始时间（可选）">
              <Input type="datetime-local" />
            </Form.Item>
            <Form.Item name="expiresAtLocal" label="过期截止时间（可选）">
              <Input type="datetime-local" />
            </Form.Item>
          </div>

          <div className="form-two">
            <Form.Item
              name="affiliateEmail"
              label="绑定专属推广员邮箱（可选）"
              extra="填写已注册用户邮箱后，买家凭码下单自动归因返佣（禁止自用）"
            >
              <Input
                aria-label="绑定专属推广员邮箱（可选）"
                type="email"
                placeholder="kol@example.com（留空为普通营销券）"
                allowClear
              />
            </Form.Item>
            <Form.Item
              name="affiliateRatePercent"
              label="推广员专属返佣比例（%）"
              extra="留空则跟随该推广员当前邀请等级比例（0–9%）"
            >
              <InputNumber
                aria-label="推广员专属返佣比例（%）"
                min={0}
                max={9}
                precision={2}
                disabled={!affiliateEmailWatch?.trim()}
                placeholder="跟随等级比例"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </div>

          <div className="form-two">
            <Form.Item name="firstOrderOnly" label="仅限首单新用户" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="requireLogin" label="需登录本站账号后可用" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              name="allowReferral"
              label="允许叠加普通 ?ref= 邀请返现"
              valuePropName="checked"
              extra="返佣始终按买家券后实付金额计算"
            >
              <Switch />
            </Form.Item>
            <Form.Item name="enabled" label="立即启用此优惠码" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <Form.Item name="note" label="内部运营备注（仅后台可见）">
            <Input.TextArea rows={2} maxLength={300} placeholder="投放渠道、活动批次说明等" />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={busy} block>
            {editing ? '保存优惠码修改' : '创建优惠码'}
          </Button>
        </Form>
      </Modal>
    </>
  )
}
