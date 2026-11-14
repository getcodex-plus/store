import { ApiError } from './config'
import { decrypt, encrypt, id, secretHash } from './crypto'
import { transaction } from './db'
import { validateInventoryCodes } from '../inventory-import'

// Credentials bind their encrypted contents to a purpose and record ID.
const version = 'v2:'
type Kind = 'inventory' | 'preflight'
export function sealCredential(value: string, kind: Kind, recordId: string) {
  return version + encrypt(value, `${kind}:${recordId}`)
}
export function openCredential(value: string, kind: Kind, recordId: string) {
  if (!value.startsWith(version)) throw new ApiError(503, '凭据格式无效，请联系管理员核对')
  return decrypt(value.slice(version.length), `${kind}:${recordId}`)
}
// Match AICDK's owned-code identity: display prefixes, case and separators do
// not turn the same 20-hex-digit card into additional sellable inventory.
export function canonicalInventoryCode(code: string) {
  const raw = code.trim().toUpperCase()
  const suffix = raw.replaceAll('-', '').slice(-20)
  return /^[A-F0-9]{20}$/.test(suffix) ? suffix : raw
}
export const inventoryFingerprint = (code: string) =>
  secretHash(`inventory-fingerprint\0${canonicalInventoryCode(code)}`)

export async function importInventory(
  productId: string,
  codes: string[],
  actor: string,
  options: {
    batchName?: string
    note?: string
    enabled?: boolean
    discountCountry?: string | null
  } = {},
) {
  try {
    codes = validateInventoryCodes(codes)
  } catch (error) {
    throw new ApiError(400, (error as Error).message)
  }
  return transaction(async (client) => {
    const product = await client.product.findUnique({ where: { id: productId } })
    if (!product) throw new ApiError(404, '商品不存在，请刷新后重试')
    const discountCountry = options.discountCountry?.trim().toLowerCase() || null
    if (
      discountCountry &&
      (!/^[a-z]{2}$/.test(discountCountry) || product.plan !== 'plus' || product.upgrade)
    )
      throw new ApiError(400, '半价库存仅支持普通 Plus 商品，地区须为两位国家代码')
    const batchId = id('batch_')
    await client.inventoryBatch.create({
      data: {
        id: batchId,
        productId,
        name: options.batchName || '手动导入',
        importedBy: actor,
        imported: 0,
        note: options.note ?? '',
        enabled: options.enabled !== false,
        discountCountry,
      },
    })
    const { count: imported } = await client.inventory.createMany({
      data: [...new Set(codes)].map((code) => {
        const itemId = id('i_')
        return {
          id: itemId,
          productId,
          code: sealCredential(code, 'inventory', itemId),
          fingerprint: inventoryFingerprint(code),
          batchId,
          discountCountry,
        }
      }),
      skipDuplicates: true,
    })
    await client.audit.create({
      data: { id: id('a_'), actor, action: '导入兑换库存', target: batchId },
    })
    const duplicates = codes.length - imported
    await client.inventoryBatch.update({ where: { id: batchId }, data: { imported, duplicates } })
    if (imported === 0)
      await client.inventoryBatch.update({ where: { id: batchId }, data: { enabled: false } })
    return { saved: true as const, imported, duplicates, batchId }
  })
}
