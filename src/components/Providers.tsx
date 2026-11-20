'use client'
import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { App, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { Bootstrap, CouponPreview } from '../types'
import { api } from '../lib'
import { attributionSource } from '../funnel-client'
import { extractCouponParam, normalizeCouponCode } from '../coupons'
import { defaultBrandName, type SiteBrand } from '../branding'

const Branding = createContext<SiteBrand>({ name: defaultBrandName })
export const useBrand = () => useContext(Branding)

const COUPON_STORAGE_KEY = 'getgpt_coupon'
const REFERRAL_STORAGE_KEY = 'getgpt_referral'
const STORAGE_TTL_MS = 30 * 86400000

interface ApplyCouponOptions {
  quoteId?: string
  silent?: boolean
  preserveNotice?: boolean
  fallbackToStored?: boolean
}

interface Context {
  nonce?: string
  data: Bootstrap | null
  error: string
  refresh: () => Promise<void>
  loginOpen: boolean
  loginIntent: 'login' | 'reset'
  openLogin: (open: boolean, intent?: 'login' | 'reset') => void
  coupon: CouponPreview | null
  couponNotice: string
  couponBusy: boolean
  applyCoupon: (code: string, options?: ApplyCouponOptions) => Promise<CouponPreview>
  clearCoupon: () => void
  dismissCouponNotice: () => void
}

const emptyPreview = (code = ''): CouponPreview => ({
  valid: false,
  code,
  items: {},
})

const State = createContext<Context>({
  data: null,
  error: '',
  refresh: async () => {},
  loginOpen: false,
  loginIntent: 'login',
  openLogin: () => {},
  coupon: null,
  couponNotice: '',
  couponBusy: false,
  applyCoupon: async (code) => emptyPreview(code),
  clearCoupon: () => {},
  dismissCouponNotice: () => {},
})
export const useSite = () => useContext(State)

function readStoredCouponCode(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem(COUPON_STORAGE_KEY) || 'null') as {
      code?: string
      expires?: number
    } | null
    if (parsed?.code && typeof parsed.expires === 'number' && parsed.expires > Date.now()) {
      return normalizeCouponCode(parsed.code)
    }
    if (parsed) localStorage.removeItem(COUPON_STORAGE_KEY)
  } catch {}
  return ''
}

function writeStoredCouponCode(code: string) {
  try {
    localStorage.setItem(
      COUPON_STORAGE_KEY,
      JSON.stringify({ code, expires: Date.now() + STORAGE_TTL_MS }),
    )
  } catch {}
}

function removeStoredCouponCode() {
  try {
    localStorage.removeItem(COUPON_STORAGE_KEY)
  } catch {}
}

function syncReferralFromAffiliate(referralCode?: string | null) {
  if (!referralCode || !/^[a-z\d]{10,12}$/.test(referralCode)) return
  try {
    const previous = JSON.parse(localStorage.getItem(REFERRAL_STORAGE_KEY) || 'null') as {
      code?: string
      expires?: number
    } | null
    if (!previous || typeof previous.expires !== 'number' || previous.expires < Date.now()) {
      localStorage.setItem(
        REFERRAL_STORAGE_KEY,
        JSON.stringify({ code: referralCode, expires: Date.now() + STORAGE_TTL_MS }),
      )
    }
  } catch {}
}

function CouponUrlWatcher({ onUrlCoupon }: { onUrlCoupon: (code: string) => void }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      return
    }
    const code = extractCouponParam(search ? `?${search}` : '')
    if (code) onUrlCoupon(code)
  }, [pathname, search, onUrlCoupon])
  return null
}

function StateProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginIntent, setLoginIntent] = useState<'login' | 'reset'>('login')
  const [coupon, setCoupon] = useState<CouponPreview | null>(null)
  const [couponNotice, setCouponNotice] = useState('')
  const [couponBusy, setCouponBusy] = useState(false)
  const activeCouponRef = useRef<CouponPreview | null>(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    activeCouponRef.current = coupon
  }, [coupon])

  const openLogin = useCallback((open: boolean, intent: 'login' | 'reset' = 'login') => {
    if (open) setLoginIntent(intent)
    setLoginOpen(open)
  }, [])

  const clearCoupon = useCallback(() => {
    requestSeq.current++
    activeCouponRef.current = null
    setCoupon(null)
    setCouponNotice('')
    removeStoredCouponCode()
  }, [])

  const dismissCouponNotice = useCallback(() => {
    setCouponNotice('')
  }, [])

  const applyCoupon = useCallback(
    async (rawCode: string, options?: ApplyCouponOptions): Promise<CouponPreview> => {
      const normalized = normalizeCouponCode(rawCode)
      if (!normalized) {
        return emptyPreview('')
      }
      const seq = ++requestSeq.current
      setCouponBusy(true)
      try {
        const preview = await api<CouponPreview>('/coupons/preview', {
          code: normalized,
          ...(options?.quoteId ? { quoteId: options.quoteId } : {}),
        })
        if (seq !== requestSeq.current) return preview
        if (preview.valid) {
          activeCouponRef.current = preview
          setCoupon(preview)
          if (!options?.preserveNotice) setCouponNotice('')
          writeStoredCouponCode(preview.code)
          syncReferralFromAffiliate(preview.affiliateReferralCode)
        } else {
          if (activeCouponRef.current?.code === preview.code) {
            activeCouponRef.current = null
            setCoupon(null)
            removeStoredCouponCode()
          }
          if (!options?.silent) {
            setCouponNotice(
              `优惠码 ${preview.code || normalized} 暂不可用：${preview.reason || '优惠码无效'}`,
            )
          }
          if (options?.fallbackToStored && !activeCouponRef.current) {
            const stored = readStoredCouponCode()
            if (stored && stored !== normalized) {
              void applyCoupon(stored, { silent: true, preserveNotice: true })
            }
          }
        }
        return preview
      } catch (e) {
        const message = (e as Error).message || '校验优惠码失败，请稍后重试'
        if (seq === requestSeq.current && !options?.silent) {
          setCouponNotice(`优惠码 ${normalized} 校验失败：${message}`)
        }
        return { valid: false, code: normalized, reason: message, items: {} }
      } finally {
        if (seq === requestSeq.current) setCouponBusy(false)
      }
    },
    [],
  )

  const refresh = useCallback(async () => {
    try {
      setData(await api<Bootstrap>('/bootstrap'))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    attributionSource()
    void refresh()
    const ref = new URLSearchParams(window.location.search).get('ref')
    if (ref && /^[a-z\d]{10,12}$/.test(ref)) {
      let previous
      try {
        previous = JSON.parse(localStorage.getItem(REFERRAL_STORAGE_KEY) || 'null')
      } catch {}
      if (!previous || previous.expires < Date.now()) {
        try {
          localStorage.setItem(
            REFERRAL_STORAGE_KEY,
            JSON.stringify({ code: ref, expires: Date.now() + STORAGE_TTL_MS }),
          )
        } catch {
          // Private browsing or storage policies must not prevent shopping.
        }
      }
    }
    const urlCoupon = extractCouponParam(window.location.search)
    const storedCoupon = readStoredCouponCode()
    if (urlCoupon) {
      void applyCoupon(urlCoupon, { silent: false, fallbackToStored: true })
    } else if (storedCoupon) {
      void applyCoupon(storedCoupon, { silent: true })
    }
  }, [refresh, applyCoupon])

  const handleUrlCoupon = useCallback(
    (urlCode: string) => {
      if (!urlCode || activeCouponRef.current?.code === urlCode) return
      void applyCoupon(urlCode, { silent: false, fallbackToStored: true })
    },
    [applyCoupon],
  )

  // Re-validate active coupon when login state changes (e.g. firstOrderOnly, perBuyerLimit, self-use).
  const userId = data?.user?.id ?? null
  const prevUserId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (prevUserId.current === undefined) {
      prevUserId.current = userId
      return
    }
    if (prevUserId.current === userId) return
    prevUserId.current = userId
    const currentCode = activeCouponRef.current?.code || readStoredCouponCode()
    if (currentCode) {
      void applyCoupon(currentCode, { silent: false })
    }
  }, [userId, applyCoupon])

  return (
    <State.Provider
      value={{
        data,
        error,
        refresh,
        loginOpen,
        loginIntent,
        openLogin,
        nonce,
        coupon,
        couponNotice,
        couponBusy,
        applyCoupon,
        clearCoupon,
        dismissCouponNotice,
      }}
    >
      <Suspense fallback={null}>
        <CouponUrlWatcher onUrlCoupon={handleUrlCoupon} />
      </Suspense>
      {children}
    </State.Provider>
  )
}
export function Providers({
  children,
  nonce,
  brand,
}: {
  children: React.ReactNode
  nonce?: string
  brand: SiteBrand
}) {
  return (
    <ConfigProvider
      locale={zhCN}
      csp={nonce ? { nonce } : undefined}
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
        <Branding.Provider value={brand}>
          <StateProvider nonce={nonce}>{children}</StateProvider>
        </Branding.Provider>
      </App>
    </ConfigProvider>
  )
}
