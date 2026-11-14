'use client'
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd'
import { api, dateTime } from '../lib'
import {
  inventoryStatusLabels,
  type InventoryBatchItem,
  type InventoryBatchList,
  type InventoryItem,
  type InventoryList,
  type InventoryStatus,
} from '../inventory-types'
import type { Product } from '../types'

const colors = {
  available: 'success',
  disabled: 'default',
  reserved: 'processing',
  consumed: 'default',
}
export function InventoryManager({
  view,
  products,
  canWrite,
  refreshKey,
  onChanged,
  batchFilter,
  onBatchFilter,
}: {
  view: 'inventory' | 'batches'
  products: Product[]
  canWrite: boolean
  refreshKey: number
  onChanged: () => Promise<void>
  batchFilter: { id: string; name: string } | null
  onBatchFilter: (batch: { id: string; name: string } | null) => void
}) {
  const { message } = App.useApp()
  const [result, setResult] = useState<InventoryList | null>(null)
  const [batches, setBatches] = useState<InventoryBatchList | null>(null)
  const [productId, setProductId] = useState<string>()
  const [status, setStatus] = useState<InventoryStatus>()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [replacement, setReplacement] = useState<InventoryItem | null>(null)
  const [replacementError, setReplacementError] = useState('')
  const [editBatch, setEditBatch] = useState<InventoryBatchItem | null>(null)
  const [batchForm] = Form.useForm()
  const revision = useRef(0)
  useEffect(() => {
    const version = ++revision.current
    setLoading(true)
    setError('')
    setSelected([])
    const query = new URLSearchParams({ page: String(page), search })
    if (productId) query.set('productId', productId)
    if (status && view === 'inventory') query.set('status', status)
    if (batchFilter && view === 'inventory') query.set('batchId', batchFilter.id)
    void api<InventoryList | InventoryBatchList>(
      `/admin/inventory${view === 'batches' ? '/batches' : ''}?${query}`,
    )
      .then((data) => {
        if (version !== revision.current) return
        if (page > 1 && data.total <= (page - 1) * 20) {
          setPage(Math.max(1, Math.ceil(data.total / 20)))
          return
        }
        if (view === 'inventory') setResult(data as InventoryList)
        else setBatches(data as InventoryBatchList)
      })
      .catch((error) => {
        if (version === revision.current) setError((error as Error).message)
      })
      .finally(() => {
        if (version === revision.current) setLoading(false)
      })
    return () => {
      revision.current++
    }
  }, [view, page, search, productId, status, batchFilter, refreshKey])
  async function change(body: unknown) {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ changed?: number }>('/admin/inventory/change', body)
      message.success(
        result.changed === undefined ? '已保存' : `已更新 ${result.changed} 个未占用兑换码`,
      )
      setSelected([])
      await onChanged()
      return true
    } catch (error) {
      setError((error as Error).message)
      setReplacementError((error as Error).message)
      await onChanged().catch(() => {})
      return false
    } finally {
      setBusy(false)
    }
  }
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id
  const selectedItems = result?.items.filter((item) => selected.includes(item.id)) ?? []
  const currentReplacement =
    result?.items.find((item) => item.id === replacement?.id) ?? replacement
  return (
    <>
      <Card>
        <div className="inventory-toolbar">
          <Space wrap>
            <Select
              aria-label="筛选商品"
              placeholder="全部商品"
              allowClear
              value={productId}
              className="inventory-product-filter"
              onChange={(value) => {
                setProductId(value)
                setPage(1)
              }}
              options={products.map((p) => ({ value: p.id, label: p.name }))}
            />
            {view === 'inventory' && (
              <Select
                aria-label="筛选兑换码状态"
                placeholder="全部状态"
                allowClear
                value={status}
                className="inventory-status-filter"
                onChange={(value) => {
                  setStatus(value)
                  setPage(1)
                }}
                options={Object.entries(inventoryStatusLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            )}
          </Space>
          <Input.Search
            placeholder={view === 'batches' ? '搜索批次名称或编号' : '搜索批次名称或库存编号'}
            allowClear
            maxLength={80}
            className="inventory-search"
            onSearch={(value) => {
              setSearch(value.trim())
              setPage(1)
            }}
          />
        </div>
        {view === 'inventory' && batchFilter && (
          <div className="mb-24">
            <Tag
              closable
              onClose={() => {
                onBatchFilter(null)
                setPage(1)
              }}
            >
              批次：{batchFilter.name}
            </Tag>
          </div>
        )}
        {error && <Alert type="error" title={error} showIcon className="mb-24" />}
        {view === 'inventory' && (
          <>
            <div className="inventory-status-summary">
              {Object.entries(inventoryStatusLabels).map(([key, label]) => (
                <span key={key}>
                  {label} <strong>{result?.counts[key as InventoryStatus] ?? '—'}</strong>
                </span>
              ))}
            </div>
            {canWrite && selected.length > 0 && (
              <div className="inventory-bulk-actions">
                <span>已选 {selected.length} 个</span>
                <Popconfirm
                  title="停用所选兑换码？"
                  description="停用后不会用于新订单。"
                  onConfirm={() => change({ action: 'disable', ids: selected })}
                >
                  <Button
                    loading={busy}
                    disabled={loading || !selectedItems.some((item) => item.status === 'available')}
                  >
                    批量停用
                  </Button>
                </Popconfirm>
                <Button
                  loading={busy}
                  disabled={loading || !selectedItems.some((item) => item.status === 'disabled')}
                  onClick={() => void change({ action: 'enable', ids: selected })}
                >
                  批量启用
                </Button>
                <Button type="text" onClick={() => setSelected([])}>
                  取消选择
                </Button>
              </div>
            )}
            <Table<InventoryItem>
              rowKey="id"
              loading={loading}
              dataSource={error ? [] : result?.items}
              scroll={{ x: 1050 }}
              pagination={{
                current: page,
                total: result?.total ?? 0,
                pageSize: 20,
                showSizeChanger: false,
                onChange: setPage,
              }}
              rowSelection={
                canWrite
                  ? {
                      selectedRowKeys: selected,
                      onChange: (keys) => setSelected(keys as string[]),
                      getCheckboxProps: (item) => ({
                        disabled: !item.manageable || busy || loading,
                      }),
                    }
                  : undefined
              }
              columns={[
                {
                  title: '兑换码',
                  width: 200,
                  render: (_, item) => (
                    <div>
                      <strong className="mono">{item.maskedCode}</strong>
                      <div className="tiny muted mono">{item.id}</div>
                    </div>
                  ),
                },
                {
                  title: '商品 / 批次',
                  width: 240,
                  render: (_, item) => (
                    <div>
                      {productName(item.productId)}
                      <div className="tiny muted">{item.batchName}</div>
                      {item.discountCountry && (
                        <div className="tiny muted">
                          50% Discount · {item.discountCountry.toUpperCase()}
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: '状态',
                  width: 160,
                  render: (_, item) => (
                    <div>
                      <Tag color={colors[item.status]}>{inventoryStatusLabels[item.status]}</Tag>
                      {item.replacementState && (
                        <div className="tiny muted">
                          {item.replacementState === 'completed'
                            ? '已更换'
                            : item.replacementState === 'pending'
                              ? '换码待核对'
                              : '需到 AICDK 核对'}
                          {item.replacementState === 'review' && item.replacementUpstreamCodeId && (
                            <div className="mono">{item.replacementUpstreamCodeId}</div>
                          )}
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: '批次状态',
                  width: 110,
                  render: (_, item) =>
                    item.batchEnabled ? (
                      <Tag color="blue">已启用</Tag>
                    ) : (
                      <span className="muted">批次已禁用</span>
                    ),
                },
                { title: '入库时间', dataIndex: 'createdAt', width: 150, render: dateTime },
                {
                  title: '操作',
                  width: 180,
                  render: (_, item) =>
                    !canWrite ? (
                      '只读'
                    ) : item.replacementState === 'pending' ? (
                      <Button
                        type="link"
                        disabled={busy || loading}
                        onClick={() => {
                          setReplacementError('')
                          setReplacement(item)
                        }}
                      >
                        核对换码
                      </Button>
                    ) : !item.manageable ? (
                      <span className="muted">
                        {item.status === 'consumed' ? '已使用' : '已锁定'}
                      </span>
                    ) : (
                      <Space>
                        {item.status === 'disabled' ? (
                          <Button
                            type="link"
                            disabled={busy || loading}
                            onClick={() => void change({ action: 'enable', ids: [item.id] })}
                          >
                            启用
                          </Button>
                        ) : (
                          <Popconfirm
                            title="停用此兑换码？"
                            onConfirm={() => change({ action: 'disable', ids: [item.id] })}
                          >
                            <Button type="link" disabled={busy || loading}>
                              停用
                            </Button>
                          </Popconfirm>
                        )}
                        <Button
                          type="link"
                          disabled={busy || loading}
                          onClick={() => {
                            setReplacementError('')
                            setReplacement(item)
                          }}
                        >
                          更换
                        </Button>
                      </Space>
                    ),
                },
              ]}
            />
          </>
        )}
        {view === 'batches' && (
          <Table<InventoryBatchItem>
            rowKey="id"
            loading={loading}
            dataSource={error ? [] : batches?.items}
            scroll={{ x: 1250 }}
            pagination={{
              current: page,
              total: batches?.total ?? 0,
              pageSize: 20,
              showSizeChanger: false,
              onChange: setPage,
            }}
            columns={[
              {
                title: '批次 / 商品',
                width: 250,
                render: (_, batch) => (
                  <div>
                    <strong>{batch.name}</strong>{' '}
                    <div className="tiny muted">{productName(batch.productId)}</div>
                    {batch.discountCountry && (
                      <div className="tiny muted">
                        50% Discount · {batch.discountCountry.toUpperCase()}
                      </div>
                    )}
                    <div className="tiny muted mono">{batch.id}</div>
                  </div>
                ),
              },
              {
                title: '导入结果',
                width: 130,
                render: (_, batch) => (
                  <div>
                    新增 {batch.imported}
                    <div className="tiny muted">重复 {batch.duplicates}</div>
                  </div>
                ),
              },
              {
                title: '当前库存',
                width: 180,
                render: (_, batch) => (
                  <div>
                    可用 {batch.counts.available} · 停用 {batch.counts.disabled}
                    <div className="tiny muted">
                      占用 {batch.counts.reserved} · 已用 {batch.counts.consumed}
                    </div>
                  </div>
                ),
              },
              {
                title: '导入记录',
                width: 180,
                render: (_, batch) => (
                  <div>
                    {dateTime(batch.createdAt)}
                    <div className="tiny muted">{batch.importedBy}</div>
                  </div>
                ),
              },
              {
                title: '备注',
                width: 180,
                dataIndex: 'note',
                render: (note: string) => <span className="inventory-note">{note || '—'}</span>,
              },
              {
                title: '供货开关',
                width: 110,
                fixed: 'right',
                render: (_, batch) => (
                  <Switch
                    aria-label={`${batch.name}供货`}
                    checked={batch.enabled}
                    checkedChildren="启用"
                    unCheckedChildren="禁用"
                    loading={busy}
                    disabled={!canWrite || loading}
                    onChange={(enabled) =>
                      void change({
                        action: enabled ? 'enable-batch' : 'disable-batch',
                        batchId: batch.id,
                      })
                    }
                  />
                ),
              },
              {
                title: '操作',
                width: 220,
                fixed: 'right',
                render: (_, batch) => (
                  <Space wrap>
                    <Button
                      type="link"
                      onClick={() => onBatchFilter({ id: batch.id, name: batch.name })}
                    >
                      查看兑换码
                    </Button>
                    {canWrite && (
                      <>
                        <Button
                          type="link"
                          disabled={busy || loading}
                          onClick={() => {
                            batchForm.setFieldsValue({ name: batch.name, note: batch.note })
                            setEditBatch(batch)
                          }}
                        >
                          编辑备注
                        </Button>
                      </>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>
      <Modal
        title="更换兑换码"
        open={!!replacement}
        destroyOnHidden
        footer={null}
        onCancel={() => {
          if (!busy) {
            setReplacement(null)
          }
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
      >
        <p>
          {currentReplacement?.replacementState === 'pending'
            ? '将核对原换码请求的结果，旧码在确认前保持锁定。'
            : '通过 AICDK 生成新兑换码，旧码将立即失效。新码自动加密保存，沿用原商品、批次和有效期。'}
        </p>
        <p className="mono">{replacement?.maskedCode}</p>
        {replacementError && <Alert type="error" title={replacementError} className="mb-24" />}
        <Button
          block
          type="primary"
          loading={busy}
          disabled={currentReplacement?.replacementState === 'review'}
          onClick={async () => {
            if (!replacement) return
            setReplacementError('')
            const ok = await change({ action: 'replace', id: replacement.id })
            if (ok) setReplacement(null)
          }}
        >
          {currentReplacement?.replacementState === 'pending' ? '核对换码' : '确认更换'}
        </Button>
      </Modal>
      <Modal
        title="编辑导入批次"
        open={!!editBatch}
        destroyOnHidden
        footer={null}
        onCancel={() => {
          if (!busy) {
            setEditBatch(null)
            batchForm.resetFields()
          }
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
      >
        <Form
          name="inventory-batch"
          form={batchForm}
          layout="vertical"
          clearOnDestroy
          onFinish={async (values) => {
            if (
              editBatch &&
              (await change({ action: 'edit-batch', batchId: editBatch.id, ...values }))
            ) {
              setEditBatch(null)
              batchForm.resetFields()
            }
          }}
        >
          <Form.Item name="name" label="批次名称" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={80} disabled={busy} />
          </Form.Item>
          <Form.Item name="note" label="批次备注">
            <Input.TextArea rows={4} maxLength={300} disabled={busy} />
          </Form.Item>
          {error && <Alert type="error" title={error} className="mb-24" />}
          <Button type="primary" htmlType="submit" block loading={busy}>
            保存批次
          </Button>
        </Form>
      </Modal>
    </>
  )
}
