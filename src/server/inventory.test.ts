import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
  process.env.APP_MODE = 'demo'
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_inventory_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
})
import { db, transaction } from './db'
import { id } from './crypto'
import { cleanupTestDatabase, prepareTestDatabase } from './database-test-support'
import { importInventory, openCredential } from './credential-storage'
import { changeInventory, inventoryBatches, inventoryList, inventoryQuerySchema } from './inventory'
import { reserveInventory } from './database-sql'
import { adminData } from './services'
import { seedDatabase } from '../../scripts/seed'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const actor = 'stock-admin@example.com'
async function product() {
  return db.product.create({
    data: {
      id: id('p_'),
      name: 'Plus',
      subtitle: '',
      description: '',
      price: 100,
      plan: 'plus',
      features: [],
    },
  })
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, promise }
}

suite('inventory batches and allocation in PostgreSQL', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await transaction(seedDatabase)
  }, 30_000)
  afterAll(cleanupTestDatabase)

  it('records import batches, canonical duplicates, notes and masked paginated inventory', async () => {
    const p = await product()
    const code = '0123456789ABCDEF0123'
    const imported = await importInventory(
      p.id,
      [code, `brand_${code.toLowerCase()}`, code],
      actor,
      {
        batchName: '土耳其补货',
        upstreamProduct: 'upstream-tr',
        country: 'TR',
        note: '低价采购',
        activate: true,
      },
    )
    expect(imported).toMatchObject({ imported: 1, duplicates: 2 })
    const [batch] = (await inventoryBatches(inventoryQuerySchema.parse({ productId: p.id }))).items
    expect(batch).toMatchObject({
      name: '土耳其补货',
      imported: 1,
      duplicates: 2,
      note: '低价采购',
      country: 'TR',
      importedBy: actor,
      active: true,
    })
    const list = await inventoryList(inventoryQuerySchema.parse({ batchId: batch.id }))
    expect(list.total).toBe(1)
    expect(list.items[0]).toMatchObject({
      maskedCode: '•••• 0123',
      batchId: batch.id,
      currentSupply: true,
    })
    expect(JSON.stringify(list)).not.toContain(code)
    expect(JSON.stringify(list)).not.toContain('fingerprint')
    expect(JSON.stringify(list)).not.toContain('v2:')
    await changeInventory(
      { action: 'edit-batch', batchId: batch.id, name: '新批次名', note: '更新后的成本备注' },
      actor,
    )
    expect(await db.inventoryBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      note: '更新后的成本备注',
      name: '新批次名',
    })
    const duplicate = await importInventory(p.id, [code], actor, { activate: true })
    expect(duplicate.imported).toBe(0)
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: p.id } })).activeInventoryBatchId,
    ).toBe(batch.id)
  })

  it('switches countries in one action, keeps existing reservations, and never falls back', async () => {
    const p = await product()
    const oldBatch = await importInventory(p.id, [id('old_'), id('old_')], actor, {
      country: 'US',
      activate: true,
    })
    const existing = await transaction((client) => reserveInventory(client, p.id))
    const nextBatch = await importInventory(p.id, [id('new_')], actor, {
      country: 'TR',
      activate: false,
    })
    await changeInventory({ action: 'enable-batch', batchId: nextBatch.batchId }, actor)
    expect(
      (await db.inventoryBatch.findUniqueOrThrow({ where: { id: oldBatch.batchId } })).enabled,
    ).toBe(false)
    expect(await db.inventory.findUnique({ where: { id: existing!.id } })).toMatchObject({
      status: 'reserved',
      batchId: oldBatch.batchId,
    })
    const next = await transaction((client) => reserveInventory(client, p.id))
    expect(next?.batchId).toBe(nextBatch.batchId)
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    const report = await adminData({
      id: 'stock_admin',
      email: actor,
      role: 'admin',
      permissions: ['products:read'],
      referralCode: '',
      createdAt: '',
      disabled: false,
    })
    expect(report.inventory.find((item) => item.productId === p.id)).toMatchObject({
      available: 0,
      reserved: 2,
    })
    await changeInventory({ action: 'enable-batch', batchId: oldBatch.batchId }, actor)
    await changeInventory({ action: 'disable-batch', batchId: oldBatch.batchId }, actor)
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    expect((await db.inventory.findUniqueOrThrow({ where: { id: existing!.id } })).status).toBe(
      'reserved',
    )
  })

  it('waits for in-flight allocation before switching the product to a new batch', async () => {
    const p = await product()
    const first = await importInventory(p.id, [id('first_')], actor, { activate: true })
    const second = await importInventory(p.id, [id('second_')], actor, { activate: false })
    const entered = gate()
    const finish = gate()
    const holder = transaction(async (client) => {
      const stock = await reserveInventory(client, p.id)
      entered.release()
      await finish.promise
      return stock
    })
    await entered.promise
    const switching = changeInventory({ action: 'enable-batch', batchId: second.batchId }, actor)
    try {
      // The product's FOR SHARE lock is held by allocation; a concurrent switch
      // cannot change the active batch until it commits.
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: p.id } })).activeInventoryBatchId,
      ).toBe(first.batchId)
    } finally {
      finish.release()
    }
    expect((await holder)?.batchId).toBe(first.batchId)
    await switching
    expect((await transaction((client) => reserveInventory(client, p.id)))?.batchId).toBe(
      second.batchId,
    )
  })

  it('replaces unused codes atomically, retains old fingerprints and rejects occupied rows', async () => {
    const p = await product()
    const original = id('original_')
    const imported = await importInventory(p.id, [original], actor, { activate: true })
    const item = await db.inventory.findFirstOrThrow({ where: { batchId: imported.batchId } })
    await expect(
      changeInventory({ action: 'replace', id: item.id, code: original }, actor),
    ).rejects.toThrow('已在库存')
    expect((await db.inventory.findUniqueOrThrow({ where: { id: item.id } })).enabled).toBe(true)
    const replacementCode = id('replacement_')
    await changeInventory({ action: 'replace', id: item.id, code: replacementCode }, actor)
    expect((await db.inventory.findUniqueOrThrow({ where: { id: item.id } })).enabled).toBe(false)
    const replacement = await transaction((client) => reserveInventory(client, p.id))
    expect(openCredential(replacement!.code, 'inventory', replacement!.id)).toBe(replacementCode)
    await expect(
      changeInventory({ action: 'disable', ids: [item.id, replacement!.id] }, actor),
    ).rejects.toThrow('不能更改')
    await expect(
      changeInventory({ action: 'replace', id: replacement!.id, code: id('unsafe_') }, actor),
    ).rejects.toThrow('不能更改')
    expect((await importInventory(p.id, [original], actor)).duplicates).toBe(1)
  })

  it('uses pagination and status/product filters across more than one page', async () => {
    const p = await product()
    await importInventory(
      p.id,
      Array.from({ length: 23 }, () => id('paged_')),
      actor,
    )
    const first = await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))
    const second = await inventoryList(inventoryQuerySchema.parse({ productId: p.id, page: 2 }))
    expect(first.total).toBe(23)
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(3)
    await changeInventory({ action: 'disable', ids: [first.items[0].id] }, actor)
    const disabled = await inventoryList(
      inventoryQuerySchema.parse({ productId: p.id, status: 'disabled' }),
    )
    expect(disabled.total).toBe(1)
    expect(disabled.counts).toMatchObject({ available: 22, disabled: 1 })
    await changeInventory({ action: 'enable', ids: [first.items[0].id] }, actor)
    expect(
      (await inventoryList(inventoryQuerySchema.parse({ productId: p.id, status: 'disabled' })))
        .total,
    ).toBe(0)
  })
})
