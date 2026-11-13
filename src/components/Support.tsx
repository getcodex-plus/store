'use client'
import Link from 'next/link'
import { useSite } from './Providers'

export function Support({ guide = false }: { guide?: boolean }) {
  const { data, error, refresh } = useSite()
  if (!data)
    return (
      <div className="support-note" aria-live="polite">
        <strong>购买前有疑问？</strong>
        {error ? (
          <p>
            支持信息暂时无法加载。
            <button type="button" className="support-retry" onClick={() => void refresh()}>
              重新加载
            </button>
          </p>
        ) : (
          <p>正在加载支持联系方式…</p>
        )}
      </div>
    )
  const email = data?.settings.supportEmail
  return (
    <div className="support-note">
      <strong>{guide ? '获取账号信息前，先确认操作方式' : '购买前有疑问？'}</strong>
      {guide && data?.settings.sessionGuideUrl && (
        <p>
          <a href={data.settings.sessionGuideUrl} target="_blank" rel="noopener noreferrer">
            打开本站提供的账号信息操作指引 ↗
          </a>
        </p>
      )}
      <p>
        {email ? (
          <>
            请联系 <a href={`mailto:${email}`}>{email}</a>，确认套餐、服务期限或操作方式。
          </>
        ) : (
          <>支持联系方式尚未公布。对套餐或账号信息有疑问时，请先暂停购买，待服务方提供明确说明。</>
        )}{' '}
        咨询时请勿发送密码、验证码或完整会话信息。
      </p>
      {!guide && <Link href="/guide#account-info">查看账号信息准备说明 →</Link>}
    </div>
  )
}
