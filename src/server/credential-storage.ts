import { ApiError } from './config'
import { decrypt, encrypt, id, secretHash } from './crypto'
import { transaction, uniqueConflict, type DbClient } from './db'
import { lockCredentialTables, lockRow } from './database-sql'
import { validateInventoryCodes } from '../inventory-import'

// The version is outside the ciphertext so legacy data can be migrated explicitly.
// Runtime readers never fall back to the old shared encryption purpose.
const version = 'v2:'
type Kind = 'inventory' | 'preflight'
export function sealCredential(value: string, kind: Kind, recordId: string) {
  return version + encrypt(value, `${kind}:${recordId}`)
}
export function openCredential(value: string, kind: Kind, recordId: string) {
  if (!value.startsWith(version))
    throw new ApiError(503, '凭据存储需要升级，请联系管理员执行数据库迁移')
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
    upstreamProduct?: string
    country?: string
    note?: string
    activate?: boolean
  } = {},
) {
  try {
    codes = validateInventoryCodes(codes)
  } catch (error) {
    throw new ApiError(400, (error as Error).message)
  }
  return transaction(async (client) => {
    if (options.activate) await lockRow(client, 'products', productId)
    if (!(await client.product.findUnique({ where: { id: productId }, select: { id: true } })))
      throw new ApiError(404, '商品不存在，请刷新后重试')
    // Do not mix old SHA-256 indexes with keyed indexes: the same card could
    // otherwise be imported twice before the migration is run.
    if (await client.inventory.count({ where: { NOT: { code: { startsWith: version } } } }))
      throw new ApiError(503, '凭据存储需要升级，请联系管理员执行数据库迁移')
    const batchId = id('batch_')
    await client.inventoryBatch.create({
      data: {
        id: batchId,
        productId,
        name: options.batchName || '手动导入',
        importedBy: actor,
        imported: 0,
        upstreamProduct: options.upstreamProduct ?? '',
        country: options.country ?? '',
        note: options.note ?? '',
        enabled: options.activate !== false,
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
        }
      }),
      skipDuplicates: true,
    })
    await client.audit.create({
      data: { id: id('a_'), actor, action: '导入兑换库存', target: batchId },
    })
    const duplicates = codes.length - imported
    await client.inventoryBatch.update({ where: { id: batchId }, data: { imported, duplicates } })
    if (options.activate && imported > 0) {
      await client.inventoryBatch.updateMany({
        where: { productId, id: { not: batchId } },
        data: { enabled: false },
      })
      await client.product.update({
        where: { id: productId },
        data: { activeInventoryBatchId: batchId },
      })
      await client.audit.create({
        data: {
          id: id('a_'),
          actor,
          action: '切换商品供货批次',
          target: `${productId}:${batchId}`,
        },
      })
    }
    if (imported === 0)
      await client.inventoryBatch.update({ where: { id: batchId }, data: { enabled: false } })
    return { saved: true as const, imported, duplicates, batchId }
  })
}

// Run inside the schema migration transaction with the app and worker stopped.
// A failure rolls back all changes; no plaintext, row values or keys are logged.
export async function migrateCredentialStorage(client: DbClient) {
  await lockCredentialTables(client)
  let after = ''
  for (;;) {
    const batch = await client.inventory.findMany({
      where: { id: { gt: after } },
      orderBy: { id: 'asc' },
      take: 200,
    })
    if (!batch.length) break
    for (const item of batch) {
      const legacy = !item.code.startsWith(version)
      const plaintext = legacy
        ? decrypt(item.code, 'getgpt')
        : openCredential(item.code, 'inventory', item.id)
      const fingerprint = inventoryFingerprint(plaintext)
      try {
        if (legacy || item.fingerprint !== fingerprint)
          await client.inventory.update({
            where: { id: item.id },
            data: {
              code: legacy ? sealCredential(plaintext, 'inventory', item.id) : item.code,
              fingerprint,
            },
          })
      } catch (error) {
        if (uniqueConflict(error))
          throw new ApiError(409, '存在同一卡密的不同展示格式，请核对重复库存后重新迁移')
        throw error
      }
      after = item.id
    }
  }
  for (;;) {
    const batch = await client.quote.findMany({
      where: { preflightToken: { not: null }, NOT: { preflightToken: { startsWith: version } } },
      orderBy: { id: 'asc' },
      take: 200,
    })
    if (!batch.length) break
    for (const quote of batch)
      await client.quote.update({
        where: { id: quote.id },
        data: {
          preflightToken: sealCredential(
            decrypt(quote.preflightToken!, 'getgpt'),
            'preflight',
            quote.id,
          ),
        },
      })
  }
}
