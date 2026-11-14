'use client'

import { Avatar } from 'antd'
import type { User } from '../types'

export function UserAvatar({
  user,
  size = 32,
}: {
  user: Pick<User, 'email' | 'avatarUrl'>
  size?: number
}) {
  const email = user.email.trim().toLowerCase()
  let color = 0
  for (const character of email) color = (Math.imul(color, 31) + character.codePointAt(0)!) | 0

  return (
    <Avatar
      key={email}
      size={size}
      src={user.avatarUrl}
      alt="用户头像"
      style={{
        background: `hsl(${Math.abs(color) % 360} 45% 35%)`,
        color: '#fff',
        fontSize: Math.round(size * 0.45),
      }}
    >
      {Array.from(email)[0]?.toUpperCase() || 'U'}
    </Avatar>
  )
}
