'use client'
import { App, Button, Space, Upload } from 'antd'
import { maxLogoBytes } from '../branding'
import { BrandMark } from './BrandMark'

export function BrandLogoField({
  value,
  onChange,
  disabled,
  id,
}: {
  value?: string
  onChange?: (logo: string) => void
  disabled: boolean
  id?: string
}) {
  const { message } = App.useApp()
  return (
    <Space wrap>
      {value ? (
        <img src={value} alt="Logo 预览" width={36} height={36} style={{ objectFit: 'contain' }} />
      ) : (
        <BrandMark />
      )}
      <Upload
        id={id}
        accept="image/png"
        disabled={disabled}
        showUploadList={false}
        beforeUpload={(file) => {
          if (file.type !== 'image/png' || file.size > maxLogoBytes) {
            message.error('请选择不超过 64 KB 的 PNG 图片')
            return false
          }
          const reader = new FileReader()
          reader.onload = () => onChange?.(String(reader.result))
          reader.onerror = () => message.error('无法读取图片，请重新选择')
          reader.readAsDataURL(file)
          return false
        }}
      >
        <Button disabled={disabled}>选择 Logo</Button>
      </Upload>
      {value && (
        <Button disabled={disabled} onClick={() => onChange?.('')}>
          恢复默认 Logo
        </Button>
      )}
    </Space>
  )
}
