import { Account } from '../../components/Account'
export const metadata = { title: '我的订单', robots: { index: false, follow: false } }
export default function Page() {
  return <Account section="orders" />
}
