'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, InputNumber, Popconfirm, Select, Space, Table } from 'antd'
import { api } from '../lib'
import type { Product } from '../types'
import type { procurementOverview, supplierCatalog } from '../server/procurement'

type Overview = Awaited<ReturnType<typeof procurementOverview>>
type Catalog = Awaited<ReturnType<typeof supplierCatalog>>
const statusNames: Record<string, string> = {
  queued: '待采购',
  polling: '待交付',
  received: '已入库',
  rejected: '上游拒绝',
  review: '需人工核对',
}
const issueNames: Record<string, string> = {
  retry_pending: '暂未确认，等待重试',
  delivery_pending: '交付超时，请核对上游原单',
  outcome_unknown: '上游结果未确认，请核对原单',
  delivery_mismatch: '交付内容与采购单不符或卡密重复',
  insufficient_balance: '上游余额不足',
  payment_failed: '上游扣款失败',
  insufficient_stock: '上游库存不足',
  stock_unavailable: '上游库存不可用',
  sku_unavailable: '上游 SKU 不可售',
  product_unavailable: '上游商品已下架',
  bad_request: '上游拒绝采购参数',
  canceled: '上游已取消',
  refunded: '上游已退款',
  partially_refunded: '上游已部分退款',
}
export function StockProcurement({
  products,
  canWrite,
  demo,
}: {
  products: Product[]
  canWrite: boolean
  demo: boolean
}) {
  const [overview, setOverview] = useState<Overview>()
  const [catalog, setCatalog] = useState<Catalog>()
  const [page, setPage] = useState(1)
  const [productId, setProductId] = useState<string>()
  const [draft, setDraft] = useState<{ skuId: number; purchaseAfterPayment: boolean }>()
  const [quantity, setQuantity] = useState<number | null>(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestKey = useRef('')
  const load = async () => setOverview(await api<Overview>('/admin/procurement'))
  useEffect(() => {
    void load().catch((err: Error) => setError(err.message))
  }, [])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const browse = (next: number) =>
    run(async () => {
      const result = await api<Catalog>(`/admin/procurement/catalog?page=${next}`)
      setCatalog(result)
      setPage(next)
      setDraft(undefined)
    })
  const options =
    catalog?.items
      .filter((item) => item.is_active && item.fulfillment_type === 'auto')
      .flatMap((item) =>
        item.skus
          .filter((sku) => sku.is_active)
          .map((sku) => ({
            value: sku.id,
            upstreamProductId: item.id,
            label: `${item.title?.['zh-CN'] || Object.values(item.title ?? {})[0] || item.id} · ${sku.sku_code} (#${sku.id}) · ${sku.price_amount} ${catalog.info.currency} · 库存 ${sku.stock_quantity === -1 ? '不限' : sku.stock_quantity}`,
          })),
      ) ?? []
  const mapping = overview?.mappings.find((item) => item.productId === productId)
  const savedOption = options.find(
    (option) =>
      mapping?.skuId === option.value &&
      mapping.integrationId === catalog?.integrationId &&
      mapping.upstreamProductId === option.upstreamProductId,
  )
  const selected = draft ? options.find((option) => option.value === draft.skuId) : savedOption
  const purchaseAfterPayment = draft?.purchaseAfterPayment ?? mapping?.purchaseAfterPayment ?? false
  function selectProduct(value: string) {
    setProductId(value)
    setDraft(undefined)
    requestKey.current = ''
  }
  const submit = () =>
    run(async () => {
      if (!mapping || !quantity) return
      requestKey.current ||= crypto.randomUUID()
      await api('/admin/procurement/orders', {
        ...mapping,
        quantity,
        requestKey: requestKey.current,
      })
      requestKey.current = ''
      await load()
    })
  return (
    <Card
      title="上游进货与 SKU 映射"
      extra={
        <Button disabled={busy} onClick={() => void run(load)}>
          刷新采购记录
        </Button>
      }
    >
      {error && <Alert type="error" title={error} showIcon />}
      <p>
        先在「支付与服务」启用 Dujiao-Next，再将自动发卡 SKU
        映射到本地充值套餐。进货从上游钱包扣款，不改变零售价。
      </p>
      <h3>已保存的映射</h3>
      <Table
        rowKey="productId"
        size="small"
        scroll={{ x: 480 }}
        loading={!overview && !error}
        dataSource={overview?.mappings}
        locale={{ emptyText: error && !overview ? '映射未加载' : '暂无已保存的映射' }}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        columns={[
          {
            title: '本地套餐',
            render: (_, item) => (
              <Button type="link" disabled={busy} onClick={() => selectProduct(item.productId)}>
                {products.find((product) => product.id === item.productId)?.name ?? item.productId}
              </Button>
            ),
          },
          { title: '上游商品 ID', dataIndex: 'upstreamProductId' },
          { title: 'SKU ID', dataIndex: 'skuId' },
          {
            title: '采购模式',
            render: (_, item) => (item.purchaseAfterPayment ? '付款后按单采购' : '手动进货'),
          },
        ]}
      />
      <h3 className="mt-20">配置映射</h3>
      <Space wrap>
        <Button loading={busy} onClick={() => void browse(1)}>
          读取上游目录
        </Button>
        {catalog && (
          <>
            {catalog.info.site_name} · 余额 {catalog.info.balance} {catalog.info.currency}
            <Button disabled={busy || page <= 1} onClick={() => void browse(page - 1)}>
              上一页
            </Button>
            第 {page} 页
            <Button
              disabled={busy || page * 50 >= catalog.total}
              onClick={() => void browse(page + 1)}
            >
              下一页
            </Button>
          </>
        )}
      </Space>
      <div className="mt-20">
        <Space wrap>
          <Select
            aria-label="本地充值套餐"
            placeholder="选择本地充值套餐"
            style={{ minWidth: 180 }}
            value={productId}
            disabled={busy}
            options={products.map((item) => ({ value: item.id, label: item.name }))}
            onChange={selectProduct}
          />
          <Select<number | string>
            aria-label="上游 SKU"
            placeholder="选择上游发卡 SKU"
            showSearch={{ optionFilterProp: 'label' }}
            style={{ minWidth: 240 }}
            disabled={busy || !catalog || !productId || !overview}
            value={selected?.value ?? (mapping && `SKU #${mapping.skuId}（已保存）`)}
            options={options}
            onChange={(value) => {
              if (typeof value === 'number')
                setDraft({
                  skuId: value,
                  purchaseAfterPayment:
                    value === savedOption?.value && !!mapping?.purchaseAfterPayment,
                })
            }}
          />
          <Checkbox
            checked={purchaseAfterPayment}
            disabled={busy || !canWrite || !selected || !productId || demo}
            onChange={(event) => {
              if (selected)
                setDraft({ skuId: selected.value, purchaseAfterPayment: event.target.checked })
            }}
          >
            付款后按单采购（每单按上游现价扣款购买 1 个码）
          </Checkbox>
          <Button
            disabled={busy || !canWrite || !productId || !selected}
            onClick={() =>
              void run(async () => {
                await api('/admin/procurement/mapping', {
                  productId,
                  skuId: selected!.value,
                  upstreamProductId: selected!.upstreamProductId,
                  integrationId: catalog!.integrationId,
                  purchaseAfterPayment,
                })
                await load()
                setDraft(undefined)
              })
            }
          >
            保存映射
          </Button>
        </Space>
      </div>
      {mapping && (
        <div className="mt-20">
          当前映射：上游商品 #{mapping.upstreamProductId} / SKU #{mapping.skuId}　
          {mapping.purchaseAfterPayment ? '付款后按单采购' : '手动进货'}　
          <Space wrap>
            <Popconfirm
              title="移除此映射？已提交的采购不受影响。"
              onConfirm={() =>
                run(async () => {
                  await api('/admin/procurement/unmap', mapping)
                  await load()
                  setDraft(undefined)
                })
              }
            >
              <Button disabled={!canWrite || busy}>解除映射</Button>
            </Popconfirm>
            <InputNumber
              aria-label="进货数量"
              min={1}
              max={500}
              precision={0}
              value={quantity}
              disabled={busy}
              onChange={(value) => {
                setQuantity(value)
                requestKey.current = ''
              }}
            />
            <Popconfirm
              title={`按上游现价扣款购买 ${quantity} 个 SKU #${mapping.skuId}？`}
              onConfirm={submit}
            >
              <Button type="primary" disabled={!canWrite || demo || busy || !quantity}>
                提交进货
              </Button>
            </Popconfirm>
          </Space>
        </div>
      )}
      {demo && <p className="tiny muted">演示模式不会提交真实采购。</p>}
      <h3 className="mt-20">采购记录</h3>
      <Table
        rowKey="id"
        size="small"
        scroll={{ x: 760 }}
        dataSource={overview?.purchases}
        locale={{ emptyText: '暂无采购记录' }}
        pagination={{ pageSize: 5 }}
        columns={[
          { title: '采购单号', dataIndex: 'id' },
          {
            title: '来源',
            render: (_, item) => (item.orderId ? `原单 ${item.orderId}` : '手动进货'),
          },
          { title: '本地套餐', dataIndex: 'productId' },
          { title: 'SKU', dataIndex: 'skuId' },
          { title: '数量', dataIndex: 'quantity' },
          { title: '上游单号', dataIndex: 'upstreamOrderId' },
          {
            title: '状态',
            render: (_, item) =>
              [
                statusNames[item.state] ?? item.state,
                item.lastError && (issueNames[item.lastError] ?? item.lastError),
              ]
                .filter(Boolean)
                .join(' · '),
          },
          { title: '入库批次', dataIndex: 'batchId' },
          {
            title: '核对',
            render: (_, item) =>
              item.orderId &&
              item.state === 'review' && (
                <Button
                  disabled={!canWrite || demo || busy}
                  onClick={() =>
                    void run(async () => {
                      await api('/admin/procurement/resync', { id: item.id })
                      await load()
                    })
                  }
                >
                  重新同步原单
                </Button>
              ),
          },
        ]}
      />
    </Card>
  )
}
