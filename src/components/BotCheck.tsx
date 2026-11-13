'use client'
import { useRef, useState } from 'react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { Alert } from 'antd'
import { useSite } from './Providers'
export function useBotCheck(scene: 'login' | 'purchase', visible = true) {
  const { data, nonce } = useSite()
  const ref = useRef<TurnstileInstance>(null)
  const [token, setToken] = useState('')
  const [error, setError] = useState(false)
  const enabled = !!data?.turnstile?.[scene]
  return {
    token: () => {
      if (enabled && !token) throw new Error('请先完成安全验证')
      return enabled ? token : undefined
    },
    reset: () => {
      setToken('')
      ref.current?.reset()
    },
    widget:
      enabled && visible ? (
        <div className="bot-check">
          <Turnstile
            ref={ref}
            siteKey={data!.turnstile.siteKey}
            scriptOptions={{ nonce }}
            options={{ action: scene, theme: 'light', size: 'flexible' }}
            onSuccess={(value) => {
              setToken(value)
              setError(false)
            }}
            onExpire={() => setToken('')}
            onError={() => {
              setToken('')
              setError(true)
            }}
          />
          {error && <Alert type="warning" title="安全验证暂时无法加载，请检查网络或稍后重试" />}
        </div>
      ) : null,
  }
}
