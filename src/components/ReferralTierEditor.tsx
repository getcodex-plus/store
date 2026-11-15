'use client'

import { PlusOutlined } from '@ant-design/icons'
import { Button, Card, Form, Input, InputNumber } from 'antd'
import { referralTiersSchema } from '../referral-policy'

type TierRule = {
  id: string
  name: string
  minimumInvites: number
  ratePercent: number
}

export function ReferralTierEditor({ disabled = false }: { disabled?: boolean }) {
  const form = Form.useFormInstance()
  return (
    <Form.List
      name="tierRules"
      rules={[
        {
          async validator(_, tiers: TierRule[] = []) {
            const result = referralTiersSchema.safeParse(
              tiers.map((tier) => ({
                ...tier,
                rateBps:
                  typeof tier.ratePercent === 'number'
                    ? Math.round(tier.ratePercent * 100)
                    : undefined,
              })),
            )
            if (!result.success) throw new Error(result.error.issues[0].message)
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <>
          {fields.map((field, index) => (
            <Card
              key={field.key}
              size="small"
              title={`等级 ${index + 1}`}
              style={{ marginBottom: 16 }}
              extra={
                <Button
                  danger
                  type="text"
                  aria-label={`删除等级 ${index + 1}`}
                  disabled={disabled || fields.length === 1}
                  onClick={() => {
                    remove(field.name)
                    if (index === 0) form.setFieldValue(['tierRules', 0, 'minimumInvites'], 0)
                  }}
                >
                  删除
                </Button>
              }
            >
              <div className="referral-tier-fields">
                <Form.Item name={[field.name, 'id']} hidden>
                  <Input />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'name']}
                  label={`等级 ${index + 1} 名称`}
                  rules={[{ required: true, whitespace: true, max: 20 }]}
                >
                  <Input maxLength={20} />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'minimumInvites']}
                  label={`等级 ${index + 1} 有效邀请（人）`}
                  rules={[{ required: true }]}
                >
                  <InputNumber
                    min={0}
                    max={1000000}
                    precision={0}
                    disabled={index === 0}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'ratePercent']}
                  label={`等级 ${index + 1} 返现（%）`}
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={9} precision={2} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            </Card>
          ))}
          <Form.ErrorList errors={errors} />
          <Button
            type="dashed"
            disabled={disabled}
            block
            icon={<PlusOutlined />}
            style={{ marginBottom: 24 }}
            onClick={() => {
              const tiers: TierRule[] = form.getFieldValue('tierRules') ?? []
              const last = tiers.at(-1)
              add({
                id: crypto.randomUUID().replaceAll('-', ''),
                name: `等级 ${fields.length + 1}`,
                minimumInvites: last ? Math.min(1000000, (last.minimumInvites ?? 0) + 5) : 0,
                ratePercent: last?.ratePercent ?? 0,
              })
            }}
          >
            新增返利等级
          </Button>
        </>
      )}
    </Form.List>
  )
}
