import Link from 'next/link'
import { publicSupport } from '../server/site-settings'

export async function Support({ guide = false }: { guide?: boolean }) {
  const { supportEmail: email, sessionGuideUrl } = await publicSupport()
  return (
    <div className="support-note">
      <strong>{guide ? '获取账号信息前，先确认操作方式' : '购买前有疑问？'}</strong>
      {guide && sessionGuideUrl && (
        <p>
          <a href={sessionGuideUrl} target="_blank" rel="noopener noreferrer">
            打开本站提供的账号信息操作指引 ↗
          </a>
        </p>
      )}
      <p>
        {email ? (
          <>
            请联系 <a href={`mailto:${email}`}>{email}</a>，确认套餐或操作方式。
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
