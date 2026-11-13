import { Account } from '../../components/Account'
export const metadata = { title: '我的钱包', robots: { index: false, follow: false } }
export default function Page() {
  return <Account section="wallet" />
}
