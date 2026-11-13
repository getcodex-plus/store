import Link from 'next/link'
export default function NotFound() {
  return (
    <main className="container prose-page">
      <div className="eyebrow">404</div>
      <h1>这一页不在这里。</h1>
      <p>链接可能已失效，请回首页继续。</p>
      <Link href="/" className="primary-link">
        回到首页 →
      </Link>
    </main>
  )
}
