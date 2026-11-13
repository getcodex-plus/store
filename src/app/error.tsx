'use client'
import { Button, Result } from 'antd'
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="container page-content">
      <Result
        status="warning"
        title="页面暂时无法加载"
        subTitle="请稍后重试；已有订单不会因为刷新而重复扣款。"
        extra={
          <Button onClick={reset} type="primary">
            重新加载
          </Button>
        }
      />
    </main>
  )
}
