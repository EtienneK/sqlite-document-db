import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * `distinct()` and `drop()` (BACKLOG item 15's first two).
 *
 * `distinct` is the interesting one: it looks like a `SELECT DISTINCT` and is
 * not, because an array field contributes its ELEMENTS. The ordering of its
 * result is unspecified in MongoDB's documentation, so the assertions here sort
 * both sides rather than pinning an order the server never promised - except
 * for the one test that checks this library's own BSON ordering.
 */
describe('distinct() and drop()', () => {
  const docs = [
    { _id: 1 as any, k: 'a', tags: ['x', 'y'], n: 5, when: new Date('2020-01-01T00:00:00Z'), size: { uom: 'cm' } },
    { _id: 2 as any, k: 'b', tags: ['y'], n: 5, when: new Date('2020-01-01T00:00:00Z'), size: { uom: 'in' } },
    { _id: 3 as any, k: 'a', tags: [], n: 7, when: new Date('2021-01-01T00:00:00Z'), size: { uom: 'cm' } },
    { _id: 4 as any, k: 'c', n: '5', flag: true },
    { _id: 5 as any, k: 'c', n: null, flag: false }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(structuredClone(docs))
    await mongo().collection('items').insertMany(structuredClone(docs))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const items = (): any => db().collection('items')
    /** Sorted by JSON text, so the comparison does not depend on either engine's order. */
    const sorted = async (field: string, filter?: any): Promise<string[]> =>
      (await items().distinct(field, filter) as unknown[]).map(v => JSON.stringify(v)).toSorted()

    describe(dbName, () => {
      describe('distinct()', () => {
        it('should return each value once', async () => {
          expect(await sorted('k')).toStrictEqual(['"a"', '"b"', '"c"'])
        })

        it('should contribute an array field ELEMENT by element', async () => {
          expect(await sorted('tags')).toStrictEqual(['"x"', '"y"'])
        })

        it('should keep values of different types apart', async () => {
          // 5 (number), '5' (string) and null are three values; a missing field
          // contributes nothing.
          expect(await sorted('n')).toStrictEqual(['"5"', '5', '7', 'null'])
        })

        it('should treat equal Dates as one value, and return real Dates', async () => {
          const values = await items().distinct('when')
          expect(values).toHaveLength(2)
          expect(values[0]).toBeInstanceOf(Date)
          expect(values.map((d: Date) => d.toISOString()).toSorted())
            .toStrictEqual(['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'])
        })

        it('should compare whole documents by value', async () => {
          expect(await sorted('size')).toStrictEqual(['{"uom":"cm"}', '{"uom":"in"}'])
        })

        it('should read a nested path', async () => {
          expect(await sorted('size.uom')).toStrictEqual(['"cm"', '"in"'])
        })

        it('should keep booleans as booleans', async () => {
          expect(await sorted('flag')).toStrictEqual(['false', 'true'])
        })

        it('should return nothing for a field no document has', async () => {
          expect(await items().distinct('nope')).toStrictEqual([])
        })

        it('should apply the filter', async () => {
          expect(await sorted('k', { n: 5 })).toStrictEqual(['"a"', '"b"'])
          expect(await sorted('k', { tags: 'y' })).toStrictEqual(['"a"', '"b"'])
        })

        it('should return nothing when the filter matches nothing', async () => {
          expect(await items().distinct('k', { k: 'zzz' })).toStrictEqual([])
        })
      })

      describe('drop()', () => {
        it('should remove the collection and its documents', async () => {
          expect(await items().drop()).toStrictEqual(true)
          expect(await db().collection('items').countDocuments({})).toStrictEqual(0)
        })

        it('should leave a re-created collection usable and empty', async () => {
          await items().drop()
          const fresh = db().collection('items')
          await fresh.insertOne({ _id: 99 as any, k: 'new' } as any)
          expect(await fresh.countDocuments({})).toStrictEqual(1)
          expect((await fresh.findOne({ _id: 99 }))?.k).toStrictEqual('new')
        })

        it('should drop the collection\'s indexes with it', async () => {
          await items().createIndex({ k: 1 })
          expect((await items().indexes()).map((i: any) => i.name)).toContain('k_1')

          await items().drop()
          // Re-created by writing to it, which is what brings the collection
          // back on BOTH engines - MongoDB creates one lazily on first write,
          // and asking a dropped collection for its indexes is an error there.
          const fresh = db().collection('items')
          await fresh.insertOne({ _id: 1 as any, k: 'a' } as any)
          expect((await fresh.indexes()).map((i: any) => i.name)).toStrictEqual(['_id_'])
        })
      })
    })
  }

  /**
   * This library only: MongoDB does not promise an order for `distinct`, so
   * the parity tests above sort both sides. This one pins the order this
   * library DOES promise - BSON type order - which is what makes its results
   * reproducible across runs.
   */
  describe('Sqlite only - result ordering', () => {
    it('should return values in BSON type order', async () => {
      const values = await dbs.sqlite().collection('items').distinct('n')
      // null/missing < numbers < strings
      expect(values).toStrictEqual([null, 5, 7, '5'])
    })
  })
})
