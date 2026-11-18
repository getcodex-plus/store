import { ImageResponse } from 'next/og'
import { BrandMark } from '../components/BrandMark'

export const alt = 'GetCodex Plus — ChatGPT recharge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#fafafa',
        color: '#171717',
        width: '100%',
        height: '100%',
        padding: '70px',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 36, fontWeight: 700 }}
      >
        <BrandMark size={64} />
        <span>GetCodex Plus</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ fontSize: 76, fontWeight: 700 }}>Your account.</div>
        <div style={{ fontSize: 76, fontWeight: 700 }}>Your monthly plan.</div>
      </div>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#636363' }}
      >
        <span>ChatGPT recharge · Independent service</span>
      </div>
    </div>,
    size,
  )
}
