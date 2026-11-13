import type { PoolClient } from 'pg'
import { ApiError } from './config'
import { decrypt, encrypt, id, secretHash } from './crypto'
import { transaction } from './db'

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
    if ((await client.query("SELECT 1 FROM inventory WHERE code NOT LIKE 'v2:%' LIMIT 1")).rowCount)
      throw new ApiError(503, '凭据存储需要升级，请联系管理员执行数据库迁移')
    for (const code of new Set(codes)) {
      const itemId = id('i_')
      await client.query(
        'INSERT INTO inventory(id,product_id,code,fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT(fingerprint) DO NOTHING',
        [itemId, productId, sealCredential(code, 'inventory', itemId), inventoryFingerprint(code)],
      )
    }
    await client.query('INSERT INTO audit(id,actor,action,target) VALUES($1,$2,$3,$4)', [
      id('a_'),
      actor,
      '导入兑换库存',
      productId,
    ])
  })
  return { saved: true }
}

// Run inside the schema migration transaction with the app and worker stopped.
// A failure rolls back all changes; no plaintext, row values or keys are logged.
export async function migrateCredentialStorage(client: PoolClient) {
  await client.query('LOCK TABLE inventory, quotes IN SHARE ROW EXCLUSIVE MODE')
  let after = ''
  for (;;) {
    const batch = (
      await client.query<{ id: string; code: string }>(
        'SELECT id,code FROM inventory WHERE id>$1 ORDER BY id LIMIT 200 FOR UPDATE',
        [after],
      )
    ).rows
    if (!batch.length) break
    for (const item of batch) {
      const legacy = !item.code.startsWith(version)
      const plaintext = legacy
        ? decrypt(item.code, 'getgpt')
        : openCredential(item.code, 'inventory', item.id)
      try {
        await client.query('UPDATE inventory SET code=$2,fingerprint=$3 WHERE id=$1', [
          item.id,
          legacy ? sealCredential(plaintext, 'inventory', item.id) : item.code,
          inventoryFingerprint(plaintext),
        ])
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ApiError(409, '存在同一卡密的不同展示格式，请核对重复库存后重新迁移')
        throw error
      }
      after = item.id
    }
  }
  for (;;) {
    const batch = (
      await client.query<{ id: string; preflight_token: string }>(
        "SELECT id,preflight_token FROM quotes WHERE preflight_token IS NOT NULL AND preflight_token NOT LIKE 'v2:%' ORDER BY id LIMIT 200 FOR UPDATE",
      )
    ).rows
    if (!batch.length) break
    for (const quote of batch)
      await client.query('UPDATE quotes SET preflight_token=$2 WHERE id=$1', [
        quote.id,
        sealCredential(decrypt(quote.preflight_token, 'getgpt'), 'preflight', quote.id),
      ])
  }
}
