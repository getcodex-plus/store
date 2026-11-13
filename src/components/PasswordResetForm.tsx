'use client'
import { useState } from 'react'
import { Alert, Button, Form, Input } from 'antd'
import { resetOpaquePassword } from '../opaque-client'

export function PasswordResetForm({
  email,
  onComplete,
  onVerifyAgain,
}: {
  email: string
  onComplete: () => Promise<void>
  onVerifyAgain: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <>
      <p>正在为 {email} 设置新密码，无需输入旧密码。</p>
      <p className="muted">重置后，所有设备上的登录会话都会退出。二步验证设置保持不变。</p>
      {error && <Alert type="error" title={error} className="mb-24" />}
      <Form
        name="account-recovery"
        layout="vertical"
        onFinish={async (values) => {
          setBusy(true)
          setError('')
          try {
            await resetOpaquePassword(values.newPassword)
            await onComplete()
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[{ required: true, min: 12, max: 128, message: '密码长度为 12–128 个字符' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认密码"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                return value === getFieldValue('newPassword')
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>
          重置密码
        </Button>
        <Button block className="mt-20" disabled={busy} onClick={onVerifyAgain}>
          重新验证身份
        </Button>
      </Form>
    </>
  )
}
