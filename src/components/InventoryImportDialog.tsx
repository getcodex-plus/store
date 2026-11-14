'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Segmented, Select, Switch } from 'antd'
import { api } from '../lib'
import { inventoryFileLimit, parseAicdkCSV, parseInventoryText } from '../inventory-import'
import type { InventoryImportResult } from '../inventory-types'
import type { Product } from '../types'

export function InventoryImportDialog({
  products,
  onClose,
  onSaved,
}: {
  products: Product[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [mode, setMode] = useState<'text' | 'csv'>('text')
  const [file, setFile] = useState<{ name: string; codes: string[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const readVersion = useRef(0)
  useEffect(
    () => () => {
      readVersion.current++
    },
    [],
  )
  return (
    <Modal
      title="导入兑换库存"
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
    >
      <Form
        name="inventory-import"
        form={form}
        layout="vertical"
        disabled={busy}
        clearOnDestroy
        initialValues={{ activate: true }}
        onFinish={async (values) => {
          setError('')
          let codes: string[]
          try {
            if (mode === 'csv' && !file) throw new Error('请先选择 AICDK CSV 文件')
            codes = mode === 'csv' ? file!.codes : parseInventoryText(values.codes ?? '')
          } catch (error) {
            setError((error as Error).message)
            return
          }
          setBusy(true)
          try {
            const result = await api<InventoryImportResult>('/admin/inventory', {
              productId: values.productId,
              batchName: values.batchName,
              upstreamProduct: values.upstreamProduct ?? '',
              country: values.country ?? '',
              note: values.note ?? '',
              activate: values.activate,
              codes,
            })
            form.resetFields()
            setFile(null)
            message.success(
              `已创建批次：导入 ${result.imported} 个，跳过重复 ${result.duplicates} 个`,
            )
            if (result.imported === 0 && values.activate)
              message.info('本批次没有新增兑换码，当前供货批次保持不变')
            await onSaved()
            onClose()
          } catch (error) {
            setError((error as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form.Item
          name="productId"
          label="绑定商品"
          rules={[{ required: true, message: '请选择站内商品' }]}
        >
          <Select options={products.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>
        <Form.Item
          name="batchName"
          label="批次名称"
          rules={[{ required: true, whitespace: true, message: '请填写批次名称' }]}
        >
          <Input maxLength={80} placeholder="例如 Plus · 土耳其 · 11 月补货" />
        </Form.Item>
        <div className="form-grid">
          <Form.Item name="upstreamProduct" label="AICDK 商品">
            <Input maxLength={120} placeholder="上游商品名称或 ID" />
          </Form.Item>
          <Form.Item name="country" label="国家 / 地区">
            <Input maxLength={80} placeholder="例如 土耳其 / TR" />
          </Form.Item>
        </div>
        <p className="tiny muted">
          请按 AICDK 导出时的商品和国家填写；实际兑换以兑换码绑定的商品为准。
        </p>
        <Segmented
          block
          className="mb-24"
          value={mode}
          disabled={busy || reading}
          options={[
            { value: 'text', label: '粘贴兑换码' },
            { value: 'csv', label: 'AICDK CSV' },
          ]}
          onChange={(value) => {
            setMode(value as 'text' | 'csv')
            setError('')
          }}
        />
        {mode === 'text' ? (
          <Form.Item name="codes" label="兑换码（每行一个）">
            <Input.TextArea
              rows={6}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </Form.Item>
        ) : (
          <div className="inventory-file-input">
            <label htmlFor="inventory-csv">选择 AICDK CSV 文件</label>
            <input
              id="inventory-csv"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={async (event) => {
                const selected = event.target.files?.[0]
                event.target.value = ''
                if (!selected) return
                const version = ++readVersion.current
                setFile(null)
                setError('')
                setReading(true)
                try {
                  if (!selected.name.toLowerCase().endsWith('.csv'))
                    throw new Error('请选择 .csv 文件')
                  if (selected.size > inventoryFileLimit) throw new Error('CSV 文件不能超过 256 KB')
                  const codes = parseAicdkCSV(await selected.text())
                  if (version !== readVersion.current) return
                  setFile({ name: selected.name, codes })
                  if (!form.getFieldValue('batchName'))
                    form.setFieldValue(
                      'batchName',
                      selected.name.replace(/\.csv$/i, '').slice(0, 80),
                    )
                } catch (error) {
                  if (version === readVersion.current) setError((error as Error).message)
                } finally {
                  if (version === readVersion.current) setReading(false)
                }
              }}
            />
            <p className="tiny muted">
              {reading
                ? '正在读取…'
                : file
                  ? `${file.name} · 已识别 ${file.codes.length} 个兑换码`
                  : '支持 AICDK 单列 code 表头，每批最多 500 个，文件不超过 256 KB。'}
            </p>
          </div>
        )}
        <Form.Item name="note" label="批次备注">
          <Input.TextArea rows={2} maxLength={300} placeholder="例如进货成本、采购日期" />
        </Form.Item>
        <Form.Item
          name="activate"
          label="导入后切换为当前供货批次"
          valuePropName="checked"
          extra="新订单只使用此批次；已有订单继续使用原兑换码。"
        >
          <Switch />
        </Form.Item>
        {error && <Alert className="mb-24" type="error" showIcon title={error} />}
        <Button htmlType="submit" type="primary" loading={busy} disabled={reading} block>
          加密保存库存
        </Button>
      </Form>
    </Modal>
  )
}
