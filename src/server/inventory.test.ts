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
import { importInventory } from './credential-storage'
import {
  changeInventory,
  inventoryBatches,
  inventoryChangeSchema,
  inventoryList,
  inventoryQuerySchema,
} from './inventory'
import { reserveInventory } from './database-sql'
import { adminData } from './services'
import { seedDatabase } from '../../scripts/seed'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const actor = 'stock-admin@example.com'
async function product(upgrade = false) {
  return db.product.create({
    data: {
      id: id('p_'),
      name: 'Plus',
      upgrade,
      pricingMode: upgrade ? 'markup' : 'fixed',
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

  it('separates discounted countries from normal stock and enforces Plus-only imports', async () => {
    const p = await product()
    const imported = await importInventory(p.id, [id('discount_')], actor, {
      discountCountry: 'JP',
    })
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    expect(await transaction((client) => reserveInventory(client, p.id, 'us'))).toBeNull()
    const stock = await transaction((client) => reserveInventory(client, p.id, 'jp'))
    expect(stock).toMatchObject({ discountCountry: 'jp', batchId: imported.batchId })
    const batch = (await inventoryBatches(inventoryQuerySchema.parse({ productId: p.id }))).items[0]
    expect(batch.discountCountry).toBe('jp')
    expect(
      (await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))).items[0]
        .discountCountry,
    ).toBe('jp')
    await expect(
      importInventory((await product(true)).id, [id('discount_')], actor, {
        discountCountry: 'us',
      }),
    ).rejects.toThrow('充值商品不存在')
    await expect(
      importInventory('go', [id('discount_')], actor, { discountCountry: 'us' }),
    ).rejects.toThrow('普通 Plus')
    await expect(
      importInventory(p.id, [id('discount_')], actor, { discountCountry: 'invalid' }),
    ).rejects.toThrow('国家代码')
  })

  it('records import batches, canonical duplicates, notes and masked paginated inventory', async () => {
    const p = await product()
    const code = '0123456789ABCDEF0123'
    const imported = await importInventory(
      p.id,
      [code, `brand_${code.toLowerCase()}`, code],
      actor,
      {
        batchName: '土耳其补货',
        note: '低价采购',
        enabled: true,
      },
    )
    expect(imported).toMatchObject({ imported: 1, duplicates: 2 })
    const [batch] = (await inventoryBatches(inventoryQuerySchema.parse({ productId: p.id }))).items
    expect(batch).toMatchObject({
      name: '土耳其补货',
      imported: 1,
      duplicates: 2,
      note: '低价采购',
      importedBy: actor,
      enabled: true,
    })
    const list = await inventoryList(inventoryQuerySchema.parse({ batchId: batch.id }))
    expect(list.total).toBe(1)
    expect(list.items[0]).toMatchObject({
      maskedCode: '•••• 0123',
      batchId: batch.id,
      batchEnabled: true,
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
    const duplicate = await importInventory(p.id, [code], actor, { enabled: true })
    expect(duplicate.imported).toBe(0)
    expect((await db.inventoryBatch.findUniqueOrThrow({ where: { id: batch.id } })).enabled).toBe(
      true,
    )
    expect(
      (await db.inventoryBatch.findUniqueOrThrow({ where: { id: duplicate.batchId } })).enabled,
    ).toBe(false)
  })

  it('supplies all enabled recharge batches independently', async () => {
    const p = await product()
    const first = await importInventory(p.id, [id('first_'), id('first_')], actor, {
      batchName: '土耳其第一批',
      enabled: true,
    })
    const existing = await transaction((client) => reserveInventory(client, p.id))
    const second = await importInventory(p.id, [id('second_')], actor, {
      batchName: '土耳其第二批',
      enabled: true,
    })
    const third = await importInventory(p.id, [id('third_')], actor, { enabled: false })
    await changeInventory({ action: 'enable-batch', batchId: third.batchId }, actor)
    expect(await db.inventoryBatch.count({ where: { productId: p.id, enabled: true } })).toBe(3)
    await changeInventory({ action: 'disable-batch', batchId: third.batchId }, actor)
    expect(await db.inventoryBatch.count({ where: { productId: p.id, enabled: true } })).toBe(2)
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
      available: 2,
      reserved: 1,
    })
    expect(report.products.find((item) => item.id === p.id)?.enabledBatchCount).toBe(2)
    const allocated = await Promise.all([
      transaction((client) => reserveInventory(client, p.id)),
      transaction((client) => reserveInventory(client, p.id)),
    ])
    expect(new Set(allocated.map((stock) => stock?.batchId))).toEqual(
      new Set([first.batchId, second.batchId]),
    )
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    await changeInventory({ action: 'disable-batch', batchId: first.batchId }, actor)
    expect((await db.inventory.findUniqueOrThrow({ where: { id: existing!.id } })).status).toBe(
      'reserved',
    )
    await changeInventory({ action: 'enable-batch', batchId: third.batchId }, actor)
    expect((await transaction((client) => reserveInventory(client, p.id)))?.batchId).toBe(
      third.batchId,
    )
  })

  it('waits for in-flight allocation before disabling a batch and continues from other batches', async () => {
    const p = await product()
    const first = await importInventory(p.id, [id('first_'), id('first_')], actor)
    const entered = gate()
    const finish = gate()
    const holder = transaction(async (client) => {
      const stock = await reserveInventory(client, p.id)
      entered.release()
      await finish.promise
      return stock
    })
    await entered.promise
    const second = await importInventory(p.id, [id('second_')], actor)
    const disabling = changeInventory({ action: 'disable-batch', batchId: first.batchId }, actor)
    try {
      expect(
        (await db.inventoryBatch.findUniqueOrThrow({ where: { id: first.batchId } })).enabled,
      ).toBe(true)
    } finally {
      finish.release()
    }
    expect((await holder)?.batchId).toBe(first.batchId)
    await disabling
    expect((await transaction((client) => reserveInventory(client, p.id)))?.batchId).toBe(
      second.batchId,
    )
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
  })

  it('keeps enabled historical inventory in the common supply pool', async () => {
    const p = await product()
    const unbatched = await importInventory(p.id, [id('unbatched_')], actor)
    await db.inventory.updateMany({
      where: { batchId: unbatched.batchId },
      data: { batchId: null },
    })
    await changeInventory({ action: 'disable-batch', batchId: unbatched.batchId }, actor)
    const batch = await importInventory(p.id, [id('batch_')], actor)
    const allocations = [
      await transaction((client) => reserveInventory(client, p.id)),
      await transaction((client) => reserveInventory(client, p.id)),
    ]
    expect(new Set(allocations.map((item) => item?.batchId))).toEqual(
      new Set([null, batch.batchId]),
    )
  })

  it('marks a free card used only after confirmation and never re-enables it', async () => {
    const p = await product()
    await importInventory(p.id, [id('manual_')], actor)
    const item = (await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))).items[0]
    expect(inventoryChangeSchema.safeParse({ action: 'consume', id: item.id }).success).toBe(false)
    await changeInventory({ action: 'consume', id: item.id, confirmed: true }, actor)
    await expect(changeInventory({ action: 'enable', ids: [item.id] }, actor)).rejects.toThrow(
      '已使用',
    )
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    expect(
      (await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))).counts.consumed,
    ).toBe(1)
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
