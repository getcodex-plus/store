'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Segmented, Select, Switch, Upload } from 'antd'
import {
  CheckCircleOutlined,
  DeleteOutlined,
  FileTextOutlined,
  UploadOutlined,
} from '@ant-design/icons'
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
  const [file, setFile] = useState<{ name: string; size: number; codes: string[] } | null>(null)
  const [error, setError] = useState('')
  const [fileError, setFileError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const readVersion = useRef(0)
  useEffect(
    () => () => {
      readVersion.current++
    },
    [],
  )
  async function readFile(selected: File) {
    const version = ++readVersion.current
    setFile(null)
    setError('')
    setFileError('')
    setReading(true)
    try {
      if (!selected.name.toLowerCase().endsWith('.csv')) throw new Error('请选择 .csv 文件')
      if (selected.size > inventoryFileLimit) throw new Error('CSV 文件不能超过 256 KB')
      const codes = parseAicdkCSV(await selected.text())
      if (version !== readVersion.current) return Upload.LIST_IGNORE
      setFile({ name: selected.name, size: selected.size, codes })
      if (!form.getFieldValue('batchName'))
        form.setFieldValue('batchName', selected.name.replace(/\.csv$/i, '').slice(0, 80))
    } catch (error) {
      if (version === readVersion.current) setFileError((error as Error).message)
    } finally {
      if (version === readVersion.current) setReading(false)
    }
    // Files are parsed locally. Never let Upload send a request or keep a second
    // copy in its internal file list.
    return Upload.LIST_IGNORE
  }
  const uploadProps = {
    accept: '.csv,text/csv',
    multiple: false,
    showUploadList: false,
    fileList: [],
    disabled: busy || reading,
    beforeUpload: readFile,
    'aria-label': '选择 CSV 文件',
  }
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
        initialValues={{ enabled: true }}
        onFinish={async (values) => {
          setError('')
          let codes: string[]
          try {
            if (mode === 'csv' && !file) {
              setFileError((current) => current || '请先选择 CSV 文件')
              return
            }
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
              note: values.note ?? '',
              enabled: values.enabled,
              codes,
            })
            form.resetFields()
            setFile(null)
            message.success(
              `已创建批次：导入 ${result.imported} 个，跳过重复 ${result.duplicates} 个`,
            )
            if (result.imported === 0 && values.enabled)
              message.info('本批次没有新增兑换码，已保存为禁用状态')
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
          <Input maxLength={80} placeholder="例如 Plus · 11 月补货" />
        </Form.Item>
        <Segmented
          block
          className="mb-24"
          value={mode}
          disabled={busy || reading}
          options={[
            { value: 'text', label: '粘贴兑换码' },
            { value: 'csv', label: 'File' },
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
          <div className="inventory-file-import" aria-busy={reading}>
            {file ? (
              <div className="inventory-file-card">
                <FileTextOutlined className="inventory-file-icon" aria-hidden="true" />
                <div className="inventory-file-details">
                  <strong>{file.name}</strong>
                  <span className="tiny muted" role="status">
                    <CheckCircleOutlined aria-hidden="true" /> 已识别 {file.codes.length} 个兑换码
                    <span className="inventory-file-size">
                      {Math.max(0.1, file.size / 1024).toFixed(1)} KB
                    </span>
                  </span>
                </div>
                <div className="inventory-file-actions">
                  <Upload {...uploadProps}>
                    <Button className="inventory-file-action" disabled={busy}>
                      更换文件
                    </Button>
                  </Upload>
                  <Button
                    type="text"
                    className="inventory-file-action"
                    icon={<DeleteOutlined />}
                    aria-label="移除文件"
                    disabled={busy}
                    onClick={() => {
                      readVersion.current++
                      setFile(null)
                      setFileError('')
                    }}
                  />
                </div>
              </div>
            ) : (
              <Upload.Dragger {...uploadProps} className="inventory-file-dropzone">
                <UploadOutlined className="inventory-upload-icon" aria-hidden="true" />
                <strong>{reading ? '正在读取文件…' : '点击选择文件，或拖入 CSV'}</strong>
                <span className="tiny muted">最多 500 个兑换码 · 256 KB</span>
              </Upload.Dragger>
            )}
            <p className="tiny muted inventory-file-hint">支持 AICDK 导出的 CSV，表头为 code。</p>
            {fileError && <Alert type="error" showIcon title={fileError} />}
          </div>
        )}
        <Form.Item name="note" label="批次备注">
          <Input.TextArea rows={2} maxLength={300} placeholder="例如进货成本、采购日期" />
        </Form.Item>
        <Form.Item
          name="enabled"
          label="导入后启用批次"
          valuePropName="checked"
          extra="同一商品的所有已启用批次共同供货，互不影响。"
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
