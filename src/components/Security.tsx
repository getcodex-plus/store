'use client'
import {
  App,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  QRCode,
  Result,
  Skeleton,
  Space,
  Switch,
  Tag,
} from 'antd'
import { KeyOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { authClient, authResult } from '../auth-client'
import { useCallback, useEffect, useState } from 'react'
import { useSite } from './Providers'
import { api, dateTime } from '../lib'

interface SecurityData {
  password: boolean
  totp: boolean
  twoStepEnabled: boolean
  passkeys: { id: string; name: string; createdAt: string }[]
}
export function Security() {
  const { data: site, openLogin } = useSite()
  const { message } = App.useApp()
  const [data, setData] = useState<SecurityData | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('我的通行密钥')
  const [setup, setSetup] = useState<{ uri: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [securityAction, setSecurityAction] = useState<'enable' | 'disable' | 'totp' | null>(null)
  const [error, setError] = useState('')
  const [form] = Form.useForm()
  const load = useCallback(async () => {
    try {
      setData(await api('/security'))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    if (site?.user) void load()
  }, [site?.user, load])
  async function action(fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
      await load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function addPasskey() {
    authResult(await authClient.passkey.addPasskey({ name }))
    message.success('Passkey 已添加，密码登录将需要二步验证')
  }
  if (site && !site.user)
    return (
      <Result
        title="登录后管理账号安全"
        extra={
          <Button onClick={() => openLogin(true)} type="primary">
            登录
          </Button>
        }
      />
    )
  return (
    <main className="container prose-page security-page">
      <h1>账号安全</h1>
      <p className="lead">管理登录方式，为账号增加一道验证。</p>
      {error && <Alert type="error" title={error} />}
      {!data ? (
        <Skeleton active />
      ) : (
        <>
          <Card className="mb-24 two-step-card">
            <div className="security-section-heading">
              <div>
                <h2>
                  <SafetyCertificateOutlined /> 二步验证
                </h2>
                <p>密码验证后，再确认一次是你本人。</p>
              </div>
              <Switch
                aria-label="二步验证"
                checked={data.twoStepEnabled}
                loading={busy}
                disabled={data.passkeys.length > 0}
                onChange={(enabled) => {
                  setCurrentPassword('')
                  setSecurityAction(enabled ? 'enable' : 'disable')
                }}
              />
            </div>
            {data.passkeys.length > 0 && (
              <p className="tiny muted">已绑定 Passkey，二步验证保持开启，保护密码备用登录。</p>
            )}
            {data.twoStepEnabled ? (
              <div className="security-methods">
                <div className="security-method">
                  <div>
                    <h3>邮箱验证码</h3>
                    <p>{site?.user?.email}</p>
                    <span className="tiny muted">二步验证开启期间始终可用。</span>
                  </div>
                  <Tag>固定开启</Tag>
                </div>
                <div className="security-method">
                  <div>
                    <h3>身份验证器（TOTP）</h3>
                    <p>
                      {data.totp
                        ? '登录时默认使用动态码，也可选择邮箱验证码。'
                        : '可选。绑定后，登录时优先使用 6 位动态码。'}
                    </p>
                  </div>
                  {data.totp ? (
                    <Tag>默认方式</Tag>
                  ) : (
                    <Button
                      onClick={() => {
                        setCurrentPassword('')
                        setSecurityAction('totp')
                      }}
                    >
                      设置 TOTP
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="security-off-note muted">
                尚未开启。开启后使用邮箱验证码，还可以添加身份验证器。
              </p>
            )}
          </Card>
          <Card
            title={
              <Space>
                <KeyOutlined />
                Passkey 通行密钥
              </Space>
            }
            className="mb-24"
          >
            <p className="muted">使用指纹、面容或设备 PIN 登录。私钥保留在你的设备上。</p>
            <ul className="security-key-list">
              {data.passkeys.map((p) => (
                <li key={p.id}>
                  <div>
                    <strong>{p.name || '通行密钥'}</strong>
                    <span className="muted">添加于 {dateTime(p.createdAt)}</span>
                  </div>
                  <Popconfirm
                    title="移除此 Passkey？"
                    description={
                      data.passkeys.length === 1
                        ? '二步验证设置会保留。移除后需要重新登录。'
                        : '你仍可使用其他登录方式。'
                    }
                    okText="移除 Passkey"
                    cancelText="保留"
                    onConfirm={() =>
                      action(async () => {
                        authResult(await authClient.passkey.deletePasskey({ id: p.id }))
                        if (data.passkeys.length === 1) window.location.reload()
                      })
                    }
                  >
                    <Button danger type="text">
                      移除
                    </Button>
                  </Popconfirm>
                </li>
              ))}
              {!data.passkeys.length && (
                <li className="muted">尚未添加 Passkey。添加后可使用指纹、面容或设备 PIN 登录。</li>
              )}
            </ul>
            <label htmlFor="passkey-name" className="security-field-label">
              通行密钥名称
            </label>
            <Space.Compact block>
              <Input
                id="passkey-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="给这个 Passkey 起个名字"
              />
              <Button type="primary" loading={busy} onClick={() => action(addPasskey)}>
                添加 Passkey
              </Button>
            </Space.Compact>
          </Card>
          <Card title={data.password ? '修改登录密码' : '设置登录密码'}>
            <Form
              form={form}
              layout="vertical"
              onFinish={(v) =>
                action(async () => {
                  if (data.password)
                    authResult(
                      await authClient.changePassword({
                        currentPassword: v.currentPassword,
                        newPassword: v.password,
                        revokeOtherSessions: true,
                      }),
                    )
                  else await api('/security/password', { password: v.password })
                  form.resetFields()
                  message.success('密码已更新，其他登录会话已注销')
                })
              }
            >
              {data.password && (
                <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}>
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
              )}
              <Form.Item
                name="password"
                label="新密码"
                rules={[{ required: true, min: 12, max: 128, message: '密码长度为 12–128 个字符' }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认密码"
                dependencies={['password']}
                rules={[
                  { required: true },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      return value === getFieldValue('password')
                        ? Promise.resolve()
                        : Promise.reject(new Error('两次密码不一致'))
                    },
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>
                保存密码
              </Button>
            </Form>
          </Card>
        </>
      )}
      <Modal
        title={
          securityAction === 'disable'
            ? '关闭二步验证'
            : securityAction === 'totp'
              ? '设置身份验证器'
              : '开启二步验证'
        }
        open={!!securityAction}
        onCancel={() => {
          setSecurityAction(null)
          setCurrentPassword('')
        }}
        okText={securityAction === 'disable' ? '关闭二步验证' : '继续'}
        cancelText="取消"
        confirmLoading={busy}
        onOk={() =>
          action(async () => {
            const password = currentPassword || undefined
            if (securityAction === 'disable') {
              authResult(await authClient.twoFactor.disable({ password }))
            } else {
              const result = authResult(
                await authClient.twoFactor.enable({
                  password,
                  method: securityAction === 'totp' ? 'totp' : 'otp',
                }),
              )
              if (securityAction === 'totp') {
                if (result.method !== 'totp') throw new Error('无法设置身份验证器，请重试')
                setSetup({
                  uri: result.totpURI!,
                  secret: new URL(result.totpURI!).searchParams.get('secret') || '',
                })
                setCode('')
              }
            }
            setSecurityAction(null)
            setCurrentPassword('')
          })
        }
      >
        <p>
          {securityAction === 'disable'
            ? '关闭后将移除身份验证器，密码登录不再要求第二步验证。'
            : '确认后继续。邮箱验证码在二步验证开启时始终可用。'}
        </p>
        {data?.password && (
          <Form layout="vertical">
            <Form.Item label="当前密码" htmlFor="security-current-password">
              <Input.Password
                id="security-current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
      <Modal
        title="绑定身份验证器"
        open={!!setup}
        onCancel={() => {
          setSetup(null)
          setCode('')
        }}
        footer={null}
        destroyOnHidden
      >
        <p>使用身份验证器扫描二维码，然后输入当前动态验证码。</p>
        {setup && (
          <div className="totp-setup">
            <QRCode value={setup.uri} />
            <details>
              <summary>无法扫码？查看手动密钥</summary>
              <code className="wrap-anywhere">{setup.secret}</code>
            </details>
          </div>
        )}
        <Input
          className="mt-24"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6 位动态验证码"
        />
        <Button
          className="mt-24"
          block
          type="primary"
          loading={busy}
          onClick={() =>
            action(async () => {
              authResult(await authClient.twoFactor.verifyTotp({ code }))
              message.success('TOTP 已启用')
              setSetup(null)
              setCode('')
            })
          }
        >
          验证并启用
        </Button>
      </Modal>
    </main>
  )
}
