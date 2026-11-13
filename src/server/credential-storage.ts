import { ApiError } from './config'
import { decrypt, encrypt, id, secretHash } from './crypto'
import { transaction, uniqueConflict, type DbClient } from './db'
import { lockCredentialTables } from './database-sql'

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

export async function importInventory(productId: string, codes: string[], actor: string) {
  await transaction(async (client) => {
    // Do not mix old SHA-256 indexes with keyed indexes: the same card could
    // otherwise be imported twice before the migration is run.
    if (await client.inventory.count({ where: { NOT: { code: { startsWith: version } } } }))
      throw new ApiError(503, '凭据存储需要升级，请联系管理员执行数据库迁移')
    for (const code of new Set(codes)) {
      const itemId = id('i_')
      await client.inventory.createMany({
        data: [
          {
            id: itemId,
            productId,
            code: sealCredential(code, 'inventory', itemId),
            fingerprint: inventoryFingerprint(code),
          },
        ],
        skipDuplicates: true,
      })
    }
    await client.audit.create({
      data: { id: id('a_'), actor, action: '导入兑换库存', target: productId },
    })
  })
  return { saved: true }
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
