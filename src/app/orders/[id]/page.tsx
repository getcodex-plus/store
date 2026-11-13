import { OrderPage } from '../../../components/OrderPage'
export const metadata = { title: '订单进度', robots: { index: false, follow: false } }
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <OrderPage id={(await params).id} />
}
