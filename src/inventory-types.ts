export const inventoryStatusLabels = {
  available: '可用',
  disabled: '已停用',
  reserved: '已占用',
  consumed: '已使用（Used）',
} as const

export type InventoryStatus = keyof typeof inventoryStatusLabels
export type InventoryReleaseRound = {
  round: number
  inventoryId: string
  state: 'awaiting_refund' | 'held' | 'pending' | 'review' | 'completed'
  canReconcile?: boolean
  upstreamCodeId?: string
}
export function visibleReleaseRounds(rounds: InventoryReleaseRound[] = [], canStart: boolean) {
  return rounds.filter(
    (entry) => canStart || (entry.state !== 'held' && entry.state !== 'awaiting_refund'),
  )
}
export type InventoryItem = {
  id: string
  productId: string
  maskedCode: string
  batchName: string
  batchId: string | null
  batchEnabled: boolean
  discountCountry: string | null
  status: InventoryStatus
  createdAt: string
  manageable: boolean
  orderReplacement?: boolean
  release?: InventoryReleaseRound & { orderId: string }
  replacementState?: 'pending' | 'review' | 'completed'
  replacementUpstreamCodeId?: string
}
export type InventoryList = {
  items: InventoryItem[]
  total: number
  counts: Record<InventoryStatus, number>
}
export type InventoryImportResult = {
  saved: true
  imported: number
  duplicates: number
  batchId: string
}
export type InventoryBatchItem = {
  id: string
  name: string
  productId: string
  importedBy: string
  imported: number
  duplicates: number
  note: string
  enabled: boolean
  discountCountry: string | null
  createdAt: string
  counts: Record<InventoryStatus, number>
}
export type InventoryBatchList = { items: InventoryBatchItem[]; total: number }
