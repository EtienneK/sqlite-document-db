import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * `$lookup` (BACKLOG item 16).
 *
 * The rules worth checking against a real server are the array ones: MongoDB
 * matches array-valued keys on BOTH sides, and returns an empty array rather
 * than omitting the field when nothing matches.
 */
describe('$lookup', () => {
  const orders = [
    { _id: 1 as any, item: 'almonds', qty: 5 },
    { _id: 2 as any, item: 'pecans', qty: 3 },
    { _id: 3 as any, item: 'nothing-matches', qty: 1 },
    { _id: 4 as any, item: 'almonds', qty: 9 }
  ]
  const inventory = [
    { _id: 10 as any, sku: 'almonds', instock: 120 },
    { _id: 11 as any, sku: 'pecans', instock: 70 },
    { _id: 12 as any, sku: 'almonds', instock: 5 },
    { _id: 13 as any, sku: 'unused', instock: 1 }
  ]
  // Array keys on both sides.
  const carts = [
    { _id: 100 as any, skus: ['almonds', 'pecans'] },
    { _id: 101 as any, skus: ['almonds', 'almonds'] },
    { _id: 102 as any, skus: [] }
  ]
  const bundles = [
    { _id: 200 as any, contains: ['almonds', 'walnuts'] },
    { _id: 201 as any, contains: ['pecans'] }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    for (const target of [sqlite(), mongo()]) {
      await target.collection('orders').insertMany(structuredClone(orders) as any)
      await target.collection('inventory').insertMany(structuredClone(inventory) as any)
      await target.collection('carts').insertMany(structuredClone(carts) as any)
      await target.collection('bundles').insertMany(structuredClone(bundles) as any)
    }
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const run = async (collection: string, pipeline: any[]): Promise<any[]> =>
      await (db().collection(collection) as any).aggregate(pipeline).toArray()

    describe(dbName, () => {
      it('should join matching documents into the named array', async () => {
        const result = await run('orders', [
          { $match: { _id: 1 } },
          { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result).toHaveLength(1)
        expect(result[0].stock.map((d: any) => d._id).toSorted()).toStrictEqual([10, 12])
      })

      it('should produce an EMPTY array when nothing matches, not omit the field', async () => {
        const result = await run('orders', [
          { $match: { _id: 3 } },
          { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock).toStrictEqual([])
        expect('stock' in result[0]).toStrictEqual(true)
      })

      it('should join every input document', async () => {
        const result = await run('orders', [
          { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } },
          { $sort: { _id: 1 } },
          { $project: { _id: 1, matched: { $literal: 0 } } }
        ])
        expect(result.map((d: any) => d._id)).toStrictEqual([1, 2, 3, 4])
      })

      it('should match a LOCAL array against any of its elements', async () => {
        const result = await run('carts', [
          { $match: { _id: 100 } },
          { $lookup: { from: 'inventory', localField: 'skus', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock.map((d: any) => d._id).toSorted()).toStrictEqual([10, 11, 12])
      })

      it('should not duplicate a foreign document a local array hits twice', async () => {
        const result = await run('carts', [
          { $match: { _id: 101 } }, // skus: ['almonds', 'almonds']
          { $lookup: { from: 'inventory', localField: 'skus', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock.map((d: any) => d._id).toSorted()).toStrictEqual([10, 12])
      })

      it('should return nothing for an empty local array', async () => {
        const result = await run('carts', [
          { $match: { _id: 102 } },
          { $lookup: { from: 'inventory', localField: 'skus', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock).toStrictEqual([])
      })

      it('should match a FOREIGN array against any of its elements', async () => {
        const result = await run('orders', [
          { $match: { _id: 1 } }, // item: 'almonds'
          { $lookup: { from: 'bundles', localField: 'item', foreignField: 'contains', as: 'bundles' } }
        ])
        expect(result[0].bundles.map((d: any) => d._id)).toStrictEqual([200])
      })

      it('should join on a nested path', async () => {
        const result = await run('orders', [
          { $match: { _id: 1 } },
          { $project: { nested: { sku: '$item' } } },
          { $lookup: { from: 'inventory', localField: 'nested.sku', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock).toHaveLength(2)
      })

      it('should overwrite an existing field named by `as`', async () => {
        const result = await run('orders', [
          { $match: { _id: 1 } },
          { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'qty' } }
        ])
        expect(Array.isArray(result[0].qty)).toStrictEqual(true)
      })

      it('should return empty arrays when the foreign collection has nothing', async () => {
        const result = await run('orders', [
          { $match: { _id: 1 } },
          { $lookup: { from: 'no-such-collection', localField: 'item', foreignField: 'sku', as: 'stock' } }
        ])
        expect(result[0].stock).toStrictEqual([])
      })

      it('should feed $unwind and $group, which is the point of it', async () => {
        const result = await run('orders', [
          { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } },
          { $unwind: '$stock' },
          { $group: { _id: '$item', total: { $sum: '$stock.instock' } } },
          { $sort: { _id: 1 } }
        ])
        expect(result).toStrictEqual([
          { _id: 'almonds', total: 250 }, // (120 + 5) for each of the two almond orders
          { _id: 'pecans', total: 70 }
        ])
      })
    })
  }

  describe('Sqlite only - rejections and batching', () => {
    const run = async (pipeline: any[]): Promise<any[]> =>
      await dbs.sqlite().collection('orders').aggregate(pipeline).toArray()

    it('should reject the pipeline/let form by name rather than ignoring it', async () => {
      await expect(run([{ $lookup: { from: 'inventory', pipeline: [], as: 'x' } }]))
        .rejects.toThrow(/pipeline form of \$lookup is not supported/)
      await expect(run([{ $lookup: { from: 'inventory', let: {}, pipeline: [], as: 'x' } }]))
        .rejects.toThrow(/not supported/)
    })

    it('should reject a missing or empty option', async () => {
      await expect(run([{ $lookup: { from: 'inventory', localField: 'item', as: 'x' } }]))
        .rejects.toThrow(/foreignField/)
      await expect(run([{ $lookup: { from: '', localField: 'a', foreignField: 'b', as: 'x' } }]))
        .rejects.toThrow(/from/)
    })

    it('should read the foreign collection ONCE regardless of input size', async () => {
      // The naive implementation is one query per input document. This counts
      // the SELECTs the join issues against `inventory`.
      const logs: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line) })
      try {
        const { Db } = await import('../src/index.js')
        const db = await Db.fromUrl(':memory:', { debug: true })
        await db.collection('inventory').insertMany(structuredClone(inventory) as any)
        await db.collection('orders').insertMany(
          Array.from({ length: 200 }, (_, i) => ({ _id: i, item: 'almonds' })) as any
        )
        logs.length = 0
        await db.collection('orders')
          .aggregate([{ $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } }])
          .toArray()
        await db.close()
      } finally {
        spy.mockRestore()
      }
      const foreignSelects = logs.filter(l => l.startsWith('SELECT data FROM') && l.includes('inventory'))
      expect(foreignSelects).toHaveLength(1)
    })
  })
})
