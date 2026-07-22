import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 6: sort()/limit()/skip(). Sorting must follow MongoDB's BSON
 * type comparison order (null/missing < numbers < strings < booleans < dates
 * for the types this library stores) - every assertion runs against real
 * MongoDB as the oracle, including the mixed-type cases.
 */
const ids = async (cursor: any): Promise<any[]> => (await cursor.toArray()).map((d: any) => d._id)

describe('Cursor sort, limit and skip', () => {
  const jan = new Date('2020-01-15T00:00:00.000Z')
  const mar = new Date('2020-03-15T00:00:00.000Z')
  const jun = new Date('2020-06-15T00:00:00.000Z')
  const dec = new Date('2020-12-15T00:00:00.000Z')

  const items = [
    { _id: 1 as any, grp: 'B', qty: 30, at: jun, misc: 'x' },
    { _id: 2 as any, grp: 'A', qty: 10, at: dec },
    { _id: 3 as any, grp: 'A', qty: 20, at: jan, misc: 'y' },
    { _id: 4 as any, grp: 'B', qty: 50, misc: 5 },
    { _id: 5 as any, grp: 'A', qty: 40, at: mar, misc: true }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(structuredClone(items))
    await mongo().collection('items').insertMany(structuredClone(items))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('should sort ascending and descending', async () => {
        expect(await ids(db().collection('items').find().sort({ qty: 1 }))).toStrictEqual([2, 3, 1, 5, 4])
        expect(await ids(db().collection('items').find().sort({ qty: -1 }))).toStrictEqual([4, 5, 1, 3, 2])
      })

      it('should accept a plain field name as the sort specification', async () => {
        expect(await ids(db().collection('items').find().sort('qty'))).toStrictEqual([2, 3, 1, 5, 4])
      })

      it('should sort by multiple keys', async () => {
        expect(await ids(db().collection('items').find().sort({ grp: 1, qty: -1 }))).toStrictEqual([5, 3, 2, 4, 1])
      })

      it('should sort missing fields first ascending, last descending', async () => {
        expect(await ids(db().collection('items').find().sort({ at: 1 }))).toStrictEqual([4, 3, 5, 1, 2])
        expect(await ids(db().collection('items').find().sort({ at: -1 }))).toStrictEqual([2, 1, 5, 3, 4])
      })

      it('should sort mixed types in BSON order: missing < number < string < boolean', async () => {
        expect(await ids(db().collection('items').find().sort({ misc: 1 }))).toStrictEqual([2, 4, 1, 3, 5])
        expect(await ids(db().collection('items').find().sort({ misc: -1 }))).toStrictEqual([5, 3, 1, 4, 2])
      })

      it('should sort Dates chronologically among themselves', async () => {
        const docs = await db().collection('items').find({ at: { $exists: true } }).sort({ at: 1 }).toArray()
        expect(docs.map(d => d._id)).toStrictEqual([3, 5, 1, 2])
      })

      it('should apply limit, skip, and both together', async () => {
        expect(await ids(db().collection('items').find().limit(2))).toStrictEqual([1, 2])
        expect(await ids(db().collection('items').find().skip(3))).toStrictEqual([4, 5])
        expect(await ids(db().collection('items').find().skip(1).limit(2))).toStrictEqual([2, 3])
        expect(await ids(db().collection('items').find().limit(0))).toStrictEqual([1, 2, 3, 4, 5])
      })

      it('should combine sort with skip and limit', async () => {
        expect(await ids(db().collection('items').find().sort({ qty: -1 }).skip(1).limit(2))).toStrictEqual([5, 1])
      })

      it('should accept sort/limit/skip via find() options', async () => {
        expect(await ids(db().collection('items').find({}, { sort: { qty: -1 }, skip: 1, limit: 2 }))).toStrictEqual([5, 1])
      })

      it('should combine a filter with sort and limit', async () => {
        expect(await ids(db().collection('items').find({ grp: 'A' }).sort({ qty: -1 }).limit(2))).toStrictEqual([5, 3])
      })

      it('should refuse sort/limit/skip once iteration has started', async () => {
        const cursor = db().collection('items').find()
        await cursor.next()
        expect(() => cursor.sort({ qty: 1 })).toThrow()
        expect(() => cursor.limit(1)).toThrow()
        expect(() => cursor.skip(1)).toThrow()
        await cursor.close()
      })
    })
  }
})
