'use client'
import { useEffect, useRef, useState } from 'react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { Alert } from 'antd'
import { useSite } from './Providers'
export function useBotCheck(scene: 'login' | 'purchase', visible = true) {
  const { data, nonce } = useSite()
  const ref = useRef<TurnstileInstance>(null)
  const token = useRef('')
  const failed = useRef(false)
  const [error, setError] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const pending = useRef<{
    promise: Promise<string>
    resolve: (token: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const enabled = !!data?.turnstile?.[scene]
  useEffect(
    () => () => {
      if (!pending.current) return
      clearTimeout(pending.current.timer)
      pending.current.reject(new DOMException('验证已取消', 'AbortError'))
      pending.current = null
    },
    [],
  )
  function fail(message: string) {
    token.current = ''
    failed.current = true
    setError(true)
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    pending.current.reject(new Error(message))
    pending.current = null
  }
  return {
    token: () => {
      if (enabled && !token.current) throw new Error('请先完成安全验证')
      return enabled ? token.current : undefined
    },
    verify: (): Promise<string | undefined> => {
      if (!enabled) return Promise.resolve(undefined)
      if (token.current) return Promise.resolve(token.current)
      if (pending.current) return pending.current.promise
      let resolve!: (value: string) => void
      let reject!: (error: Error) => void
      const promise = new Promise<string>((accept, decline) => {
        resolve = accept
        reject = decline
      })
      pending.current = {
        promise,
        resolve,
        reject,
        timer: setTimeout(() => fail('安全验证超时，请重试'), 120_000),
      }
      if (failed.current) ref.current?.reset()
      failed.current = false
      setError(false)
      return promise
    },
    reset: (restart = true) => {
      token.current = ''
      failed.current = false
      setError(false)
      setInteractive(false)
      // A completed step unmounts the widget; don't start another challenge.
      if (restart) ref.current?.reset()
    },
    widget:
      enabled && visible ? (
        <div
          className="bot-check"
          style={scene === 'login' && !interactive && !error ? { margin: 0 } : undefined}
        >
          <Turnstile
            ref={ref}
            siteKey={data!.turnstile.siteKey}
            scriptOptions={{
              nonce,
              onError: () => fail('安全验证暂时无法加载，请刷新页面重试'),
            }}
            options={{
              action: scene,
              theme: 'light',
              size: 'flexible',
              execution: 'render',
              appearance: scene === 'login' ? 'interaction-only' : 'always',
            }}
            onBeforeInteractive={() => setInteractive(true)}
            onAfterInteractive={() => setInteractive(false)}
            onSuccess={(value) => {
              token.current = value
              failed.current = false
              setError(false)
              setInteractive(false)
              if (!pending.current) return
              clearTimeout(pending.current.timer)
              pending.current.resolve(value)
              pending.current = null
            }}
            onExpire={() => {
              token.current = ''
              if (pending.current) fail('安全验证已过期，请重试')
            }}
            onTimeout={() => fail('安全验证超时，请重试')}
            onUnsupported={() => fail('当前浏览器不支持安全验证，请更换浏览器重试')}
            onError={() => fail('安全验证暂时无法完成，请重试')}
          />
          {error && <Alert type="warning" title="安全验证暂时无法加载，请检查网络或稍后重试" />}
        </div>
      ) : null,
  }
}
