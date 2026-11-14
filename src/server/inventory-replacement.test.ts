import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
  process.env.APP_MODE = 'demo'
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_replacement_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
})
import { db, transaction } from './db'
import { encrypt, id } from './crypto'
import { cleanupTestDatabase, prepareTestDatabase } from './database-test-support'
import { importInventory, openCredential } from './credential-storage'
import {
  changeInventory,
  inventoryChangeSchema,
  inventoryList,
  inventoryQuerySchema,
} from './inventory'
import { reserveInventory } from './database-sql'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const actor = 'stock-admin@example.com'
const preview = {
  product_id: 'upstream_plus',
  product_name: 'Plus',
  plan: 'plus',
  expires_at: null,
}
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
const result = (newCode = id('new_code_')) => ({
  ...preview,
  id: id('r_'),
  old_code_id: id('old_'),
  new_code_id: id('new_'),
  new_code: newCode,
})
async function stock(enabled = true, discountCountry: string | null = null) {
  const p = await db.product.create({
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
  const original = id('original_')
  const batch = await importInventory(p.id, [original], actor, { discountCountry })
  const item = await db.inventory.findFirstOrThrow({ where: { batchId: batch.batchId } })
  if (!enabled) await changeInventory({ action: 'disable', ids: [item.id] }, actor)
  return { p, item, original }
}

suite('upstream inventory replacement in PostgreSQL', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.integration.create({
      data: {
        id: 'aicdk_original',
        provider: 'aicdk',
        enabled: true,
        active: true,
        public: { url: 'http://aicdk.test' },
        secret: encrypt(JSON.stringify({ apiKey: 'test-api-key' }), 'integration:aicdk'),
      },
    })
  }, 30_000)
  afterEach(() => vi.unstubAllGlobals())
  afterAll(cleanupTestDatabase)

  it('preserves the discount country when replacing a card', async () => {
    const { p, item } = await stock(true, 'jp')
    const upstream = result()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok(upstream)),
    )
    await changeInventory({ action: 'replace', id: item.id }, actor)
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    const replacement = await transaction((client) => reserveInventory(client, p.id, 'jp'))
    expect(replacement).toMatchObject({ discountCountry: 'jp', batchId: item.batchId })
    expect(replacement!.id).not.toBe(item.id)
  })

  it('replaces through the API once for concurrent clicks, encrypts the new code and never re-enables the original', async () => {
    const { p, item, original } = await stock()
    const upstream = result()
    const fetcher = vi.fn().mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok(upstream))
    vi.stubGlobal('fetch', fetcher)
    const [first, duplicate] = await Promise.all([
      changeInventory({ action: 'replace', id: item.id }, actor),
      changeInventory({ action: 'replace', id: item.id }, actor),
    ])
    expect(first).toEqual(duplicate)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://aicdk.test/api/v1/replacements/previews',
      'http://aicdk.test/api/v1/replacements',
    ])
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ code: original })
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toMatch(/^replace_/)
    expect((await db.inventory.findUniqueOrThrow({ where: { id: item.id } })).enabled).toBe(false)
    await expect(changeInventory({ action: 'enable', ids: [item.id] }, actor)).rejects.toThrow(
      '旧码不能',
    )
    const list = await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))
    expect(list.items.find((row) => row.id === item.id)).toMatchObject({
      manageable: false,
      replacementState: 'completed',
    })
    expect(JSON.stringify(list)).not.toContain(upstream.new_code)
    expect(JSON.stringify(first)).not.toContain(upstream.new_code)
    const replacement = await transaction((client) => reserveInventory(client, p.id))
    expect(replacement?.batchId).toBe(item.batchId)
    expect(openCredential(replacement!.code, 'inventory', replacement!.id)).toBe(upstream.new_code)
    expect((await importInventory(p.id, [original], actor)).duplicates).toBe(1)
    expect(
      inventoryChangeSchema.safeParse({ action: 'replace', id: item.id, code: 'manual-input' })
        .success,
    ).toBe(false)
  })

  it('shows Used separately, and blocks changing or replacing occupied and used codes', async () => {
    const { p, item } = await stock()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const status of ['reserved', 'consumed']) {
      await db.inventory.update({ where: { id: item.id }, data: { status } })
      await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
        '不能更换',
      )
      await expect(changeInventory({ action: 'enable', ids: [item.id] }, actor)).rejects.toThrow(
        '不能更改',
      )
    }
    const list = await inventoryList(
      inventoryQuerySchema.parse({ productId: p.id, status: 'consumed' }),
    )
    expect(list.items[0]).toMatchObject({ status: 'consumed', manageable: false })
    expect(list.counts.consumed).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the original state when preview is refused and preserves disabled state on successful replacement', async () => {
    const { p, item } = await stock(false)
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'CDK_LOCKED', uncertain: false },
        }),
        { status: 409 },
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
      '暂不允许',
    )
    expect(await db.inventoryReplacement.count({ where: { inventoryId: item.id } })).toBe(0)
    fetcher.mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok(result()))
    await changeInventory({ action: 'replace', id: item.id }, actor)
    expect(await db.inventory.count({ where: { productId: p.id, enabled: true } })).toBe(0)
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
  })

  it('quarantines timeouts and recovers with the same key and pinned configuration, without previewing again', async () => {
    const { p, item } = await stock()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(preview))
      .mockRejectedValueOnce(new Error('network lost'))
    vi.stubGlobal('fetch', fetcher)
    await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
      '待核对',
    )
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
    expect(
      (await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))).items[0],
    ).toMatchObject({ replacementState: 'pending', manageable: false })
    await expect(changeInventory({ action: 'enable', ids: [item.id] }, actor)).rejects.toThrow(
      '旧码不能',
    )
    await db.integration.update({ where: { id: 'aicdk_original' }, data: { active: false } })
    try {
      fetcher.mockResolvedValueOnce(ok(result()))
      await changeInventory({ action: 'replace', id: item.id }, actor)
      expect(fetcher.mock.calls[2][0]).toBe(fetcher.mock.calls[1][0])
      expect(fetcher.mock.calls[2][1].headers['Idempotency-Key']).toBe(
        fetcher.mock.calls[1][1].headers['Idempotency-Key'],
      )
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(await transaction((client) => reserveInventory(client, p.id))).not.toBeNull()
    } finally {
      await db.integration.update({ where: { id: 'aicdk_original' }, data: { active: true } })
    }
  })

  it('records one-time secret loss for review and never offers the old code again', async () => {
    const { p, item } = await stock()
    const { new_code: _secret, ...metadata } = result()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(preview))
      .mockRejectedValueOnce(new Error('response lost after upstream commit'))
      .mockResolvedValueOnce(ok({ ...metadata, secret_returned_once: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
      '待核对',
    )
    await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
      '到 AICDK 核对',
    )
    const row = (await inventoryList(inventoryQuerySchema.parse({ productId: p.id }))).items[0]
    expect(row).toMatchObject({
      replacementState: 'review',
      replacementUpstreamCodeId: metadata.new_code_id,
    })
    await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
      '到 AICDK 核对',
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
  })

  it('quarantines an unexpected product or duplicate replacement code', async () => {
    for (const mismatch of ['product', 'duplicate']) {
      const { p, item, original } = await stock()
      const upstream =
        mismatch === 'duplicate' ? result(original) : { ...result(), product_id: 'wrong-product' }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok(upstream)),
      )
      await expect(changeInventory({ action: 'replace', id: item.id }, actor)).rejects.toThrow(
        '到 AICDK 核对',
      )
      expect(await transaction((client) => reserveInventory(client, p.id))).toBeNull()
      expect(await db.inventory.count({ where: { productId: p.id } })).toBe(1)
    }
  })
})
