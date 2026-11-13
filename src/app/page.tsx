import Link from 'next/link'
import { products } from '../server/services'
import { PlanCard } from '../components/PlanCard'
import { ProPlanCard } from '../components/ProPlanCard'
export const dynamic = 'force-dynamic'
export const metadata = { alternates: { canonical: '/' } }
export default async function Home() {
  const catalog = await products()
  const proVariants = ['pro5', 'pro20', 'promax'].flatMap((plan) => {
    const product = catalog.find((p) => !p.upgrade && p.plan === plan)
    return product ? [product] : []
  })
  const proIds = new Set(proVariants.map((p) => p.id))
  const upgradeOffer =
    catalog.find((p) => p.upgrade && p.plan === 'pro20') || catalog.find((p) => p.upgrade)
  return (
    <main>
      <section className="hero container">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" /> 你的 GPT 升级助手
          </div>
          <h1>
            把精力留给灵感。
            <br />
            <span>升级的事，交给我们。</span>
          </h1>
          <p>
            为自己的 GPT 账号充值与升级。
            <br />
            先确认账号和价格，再安心付款。
          </p>
          <div className="hero-actions">
            <a href="#plans" className="primary-link">
              选择适合我的套餐 <span>↗</span>
            </a>
            <Link href="/guide" className="text-link">
              第一次充值？看这里 <span>→</span>
            </Link>
          </div>
          <div className="hero-notes">
            <span>✓ 自己的账号</span>
            <span>✓ 先验证后付款</span>
            <span>✓ 进度随时可查</span>
          </div>
        </div>
        <div className="hero-art" aria-label="账号升级流程示意">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-star">✦</span>
          <span className="art-dot" />
          <div className="floating-card card-account">
            <div className="mini-avatar">G</div>
            <div>
              <small>你的专属账号</small>
              <strong>下一站，更大的可能</strong>
            </div>
            <span className="status-check">✓</span>
          </div>
          <div className="upgrade-card">
            <div className="upgrade-icon">✳</div>
            <div className="art-label">A LITTLE UPGRADE.</div>
            <h2>
              A lot more
              <br />
              possibilities.
            </h2>
            <div className="art-divider" />
            <div className="upgrade-card-bottom">
              <span>从想法，到实现</span>
              <span>↗</span>
            </div>
          </div>
          <div className="floating-card card-status">
            <span className="status-check">✓</span>
            <div>
              <strong>每一步，都心中有数</strong>
              <small>账号确认 → 付款 → 充值到账</small>
            </div>
          </div>
          <span className="art-caption">LESS FRICTION. MORE CREATION.</span>
        </div>
      </section>
      <section id="plans" className="plans-section">
        <div className="container">
          <div className="section-heading">
            <div>
              <div className="eyebrow">FIND YOUR FIT</div>
              <h2>好工具，选适合自己的。</h2>
              <p>无需共享账号。选择套餐，开始你的下一步。</p>
            </div>
            <span className="subtle-pill">支持支付宝 · 微信 · 加密货币</span>
          </div>
          <div className="catalog-group">
            <h3>充值套餐</h3>
            <div className="plan-grid">
              {catalog
                .filter((p) => !p.upgrade && !proIds.has(p.id))
                .map((product) => (
                  <PlanCard key={product.id} product={product} />
                ))}
              {proVariants.length > 0 && <ProPlanCard products={proVariants} />}
            </div>
          </div>
          {upgradeOffer && (
            <article className="upgrade-offer">
              <div>
                <div className="eyebrow">READY FOR MORE</div>
                <h3>升级现有订阅</h3>
                <p>选择想升级的套餐，检查账号后获取本次总价。确认报价，再付款。</p>
                <span className="tiny muted">支持 Plus / Pro 100 / Pro 200 / Pro 500</span>
              </div>
              <Link href={`/checkout?product=${upgradeOffer.id}`} className="primary-link">
                查看我的升级报价 <span>↗</span>
              </Link>
            </article>
          )}
        </div>
      </section>
      <section className="container steps-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">MADE SIMPLE</div>
            <h2>第一次充值，也能轻松完成。</h2>
          </div>
          <Link href="/guide" className="text-link">
            查看完整指南 →
          </Link>
        </div>
        <div className="how-grid">
          {[
            ['01', '选一个适合的套餐', '按使用需求选择，升级前先检查账号。'],
            ['02', '确认账号和价格', '按指引提供账号信息，确认本次充值对象。'],
            ['03', '付款，等待到账', '在订单页查看进度，需要处理时会提示你。'],
          ].map(([n, title, desc]) => (
            <div className="how-step" key={n}>
              <span>{n}</span>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="container">
        <div className="referral-strip">
          <div className="gift-art">✧</div>
          <div>
            <div className="eyebrow">GOOD THINGS ARE BETTER SHARED</div>
            <h2>把好用的，分享给朋友。</h2>
            <p>朋友通过你的链接购买并完成充值，你可以获得邀请返现。游客购买也支持。</p>
          </div>
          <Link href="/referral" className="secondary-link">
            了解邀请奖励 <span>↗</span>
          </Link>
        </div>
      </section>
      <section className="container faq-section">
        <div>
          <div className="eyebrow">A FEW ANSWERS</div>
          <h2>你可能想知道</h2>
        </div>
        <div className="faq-list">
          {[
            [
              '需要提供账号密码吗？',
              '不需要提供密码。充值需要完整的账号会话信息，它属于敏感登录凭证。请仅在确认服务方与用途后提交，并避免发送给无关人员。',
            ],
            [
              '已经有订阅，还能升级吗？',
              '可以先选择升级套餐并验证账号。是否支持本次升级，以账号检查结果为准；检查通过后再付款。',
            ],
            [
              '付款后在哪里查看进度？',
              '游客可保留订单页查看；更换设备后，用联系邮箱登录查看“我的订单”。付款成功与充值完成是两个独立状态，请以“充值完成”为准。',
            ],
            [
              '遇到充值失败怎么办？',
              '保留原订单，在订单页查看处理提示。需要更新账号信息时可继续原订单，不要重复购买。',
            ],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <span>+</span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  )
}
