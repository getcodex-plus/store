export const inventoryStatusLabels = {
  available: '可用',
  disabled: '已停用',
  reserved: '已占用',
  consumed: '已使用',
} as const

export type InventoryStatus = keyof typeof inventoryStatusLabels
export type InventoryItem = {
  id: string
  productId: string
  maskedCode: string
  batchName: string
  batchId: string | null
  currentSupply: boolean
  batchEnabled: boolean
  status: InventoryStatus
  createdAt: string
  manageable: boolean
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
  upstreamProduct: string
  country: string
  note: string
  active: boolean
  enabled: boolean
  createdAt: string
  counts: Record<InventoryStatus, number>
}
export type InventoryBatchList = { items: InventoryBatchItem[]; total: number }
