import { Suspense } from 'react'
import { Checkout } from '../../components/Checkout'
export const metadata = { title: '确认充值账号', robots: { index: false, follow: false } }
export default function Page() {
  return (
    <Suspense fallback={<main className="container page-content">正在准备结算…</main>}>
      <Checkout />
    </Suspense>
  )
}
