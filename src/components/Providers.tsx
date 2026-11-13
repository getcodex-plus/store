'use client'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { App, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { Bootstrap } from '../types'
import { api } from '../lib'

interface Context {
  data: Bootstrap | null
  error: string
  refresh: () => Promise<void>
  loginOpen: boolean
  openLogin: (open: boolean) => void
}
const State = createContext<Context>({
  data: null,
  error: '',
  refresh: async () => {},
  loginOpen: false,
  openLogin: () => {},
})
export const useSite = () => useContext(State)
function StateProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const [loginOpen, openLogin] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setData(await api<Bootstrap>('/bootstrap'))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const ref = new URLSearchParams(window.location.search).get('ref')
    if (ref && /^[a-z\d]{10,12}$/.test(ref)) {
      let previous
      try {
        previous = JSON.parse(localStorage.getItem('getgpt_referral') || 'null')
      } catch {}
      if (!previous || previous.expires < Date.now())
        localStorage.setItem(
          'getgpt_referral',
          JSON.stringify({ code: ref, expires: Date.now() + 30 * 86400000 }),
        )
    }
  }, [refresh])
  return (
    <State.Provider value={{ data, error, refresh, loginOpen, openLogin }}>
      {children}
    </State.Provider>
  )
}
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // A monochrome seed needs explicit light state colors: the generated
          // brand palette otherwise puts dark text on dark selected surfaces.
          colorPrimary: '#171717',
          colorPrimaryBg: '#f5f5f5',
          colorPrimaryBgHover: '#e5e5e5',
          colorPrimaryBorder: '#d4d4d4',
          colorPrimaryBorderHover: '#636363',
          colorPrimaryHover: '#404040',
          colorPrimaryActive: '#262626',
          colorPrimaryText: '#171717',
          colorPrimaryTextHover: '#404040',
          colorPrimaryTextActive: '#262626',
          controlItemBgHover: '#fafafa',
          controlItemBgActive: '#f5f5f5',
          controlItemBgActiveHover: '#e5e5e5',
          controlItemBgActiveDisabled: '#f5f5f5',
          controlOutline: '#636363',
          colorInfo: '#404040',
          colorInfoBg: '#fafafa',
          colorInfoBgHover: '#f5f5f5',
          colorInfoBorder: '#e5e5e5',
          colorInfoText: '#404040',
          colorSuccess: '#404040',
          colorSuccessBg: '#f5f5f5',
          colorSuccessBgHover: '#e5e5e5',
          colorSuccessBorder: '#d4d4d4',
          colorSuccessText: '#404040',
          colorWarning: '#946200',
          colorWarningBg: '#fff8e8',
          colorWarningBgHover: '#fff0cc',
          colorWarningBorder: '#e8d3a3',
          colorWarningBorderHover: '#946200',
          colorWarningHover: '#785000',
          colorWarningActive: '#634100',
          colorWarningText: '#946200',
          colorWarningTextHover: '#785000',
          colorWarningTextActive: '#634100',
          colorError: '#b42318',
          colorErrorBg: '#fff2f0',
          colorErrorBgHover: '#ffe5e0',
          colorErrorBorder: '#ffccc7',
          colorErrorBorderHover: '#b42318',
          colorErrorHover: '#9f1c14',
          colorErrorActive: '#82150f',
          colorErrorText: '#b42318',
          colorErrorTextHover: '#9f1c14',
          colorErrorTextActive: '#82150f',
          colorLink: '#171717',
          colorLinkHover: '#636363',
          colorLinkActive: '#262626',
          colorText: '#171717',
          colorTextSecondary: '#636363',
          colorTextTertiary: '#636363',
          colorTextQuaternary: '#636363',
          colorTextPlaceholder: '#636363',
          colorTextDisabled: '#636363',
          colorBgContainerDisabled: '#f5f5f5',
          colorTextLightSolid: '#ffffff',
          borderRadius: 10,
          controlHeight: 42,
          colorBgLayout: '#fafafa',
          colorBorder: '#d4d4d4',
          fontFamily: 'Arial, Helvetica, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Menu: {
            itemColor: '#636363',
            itemSelectedColor: '#171717',
            itemSelectedBg: '#f5f5f5',
            itemHoverColor: '#171717',
            itemHoverBg: '#fafafa',
            itemHeight: 43,
            itemBorderRadius: 8,
          },
        },
      }}
    >
      <App>
        <StateProvider>{children}</StateProvider>
      </App>
    </ConfigProvider>
  )
}
