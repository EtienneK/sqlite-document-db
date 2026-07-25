import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * Query an Array of Embedded Documents -
 * https://www.mongodb.com/docs/manual/tutorial/query-array-of-documents/
 *
 * The tutorial BACKLOG item 13 flagged as missing, and writing an example
 * against it is what surfaced the bug this spec now guards: a dotted path
 * THROUGH an array (`{ 'instock.qty': 5 }`) matched nothing, because
 * `json_extract(data,'$.instock.qty')` is NULL when `instock` is an array.
 * MongoDB descends into arrays at every level of a path, not just the last.
 */
describe('Query an Array of Embedded Documents', () => {
  const inventory = [
    { _id: 1 as any, item: 'journal', instock: [{ warehouse: 'A', qty: 5 }, { warehouse: 'C', qty: 15 }] },
    { _id: 2 as any, item: 'notebook', instock: [{ warehouse: 'C', qty: 5 }] },
    { _id: 3 as any, item: 'paper', instock: [{ warehouse: 'A', qty: 60 }, { warehouse: 'B', qty: 15 }] },
    { _id: 4 as any, item: 'planner', instock: [{ warehouse: 'A', qty: 40 }, { warehouse: 'B', qty: 5 }] },
    { _id: 5 as any, item: 'postcard', instock: [{ warehouse: 'B', qty: 15 }, { warehouse: 'C', qty: 35 }] }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('inventory').insertMany(structuredClone(inventory))
    await mongo().collection('inventory').insertMany(structuredClone(inventory))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const ids = async (filter: any): Promise<any[]> =>
      (await db().collection('inventory').find(filter).toArray()).map(d => d._id)

    describe(dbName, () => {
      it('should query for a document nested in an array', async () => {
        // The whole element, matched exactly and in field order.
        expect(await ids({ instock: { warehouse: 'A', qty: 5 } })).toStrictEqual([1])
        expect(await ids({ instock: { qty: 5, warehouse: 'A' } })).toStrictEqual([])
      })

      it('should specify a query condition on a field in an array of documents', async () => {
        // THE REGRESSION: a dotted path with no index descends into the array.
        expect(await ids({ 'instock.qty': 5 })).toStrictEqual([1, 2, 4])
        expect(await ids({ 'instock.qty': { $lte: 20 } })).toStrictEqual([1, 2, 3, 4, 5])
        expect(await ids({ 'instock.warehouse': 'A' })).toStrictEqual([1, 3, 4])
      })

      it('should use the array index to query a field in the embedded document', async () => {
        expect(await ids({ 'instock.0.qty': { $lte: 20 } })).toStrictEqual([1, 2, 5])
        expect(await ids({ 'instock.1.qty': { $gt: 20 } })).toStrictEqual([5])
        expect(await ids({ 'instock.0.warehouse': 'A' })).toStrictEqual([1, 3, 4])
      })

      it('should specify multiple conditions on an array of documents', async () => {
        // A single element must satisfy every condition...
        expect(await ids({ instock: { $elemMatch: { qty: 5, warehouse: 'A' } } })).toStrictEqual([1])
        expect(await ids({ instock: { $elemMatch: { qty: { $gt: 10, $lte: 20 } } } })).toStrictEqual([1, 3, 5])

        // ...whereas without $elemMatch, DIFFERENT elements may satisfy each
        // condition. This is the distinction the tutorial exists to teach.
        expect(await ids({ 'instock.qty': { $gt: 10, $lte: 20 } })).toStrictEqual([1, 3, 4, 5])
        expect(await ids({ 'instock.qty': 5, 'instock.warehouse': 'A' })).toStrictEqual([1, 4])
      })

      it('should apply the same rule to the other operators', async () => {
        expect(await ids({ 'instock.qty': { $in: [5, 35] } })).toStrictEqual([1, 2, 4, 5])
        expect(await ids({ 'instock.warehouse': { $regex: /^C$/ } })).toStrictEqual([1, 2, 5])
        expect(await ids({ 'instock.qty': { $exists: true } })).toStrictEqual([1, 2, 3, 4, 5])
        expect(await ids({ 'instock.nope': { $exists: true } })).toStrictEqual([])
        expect(await ids({ 'instock.qty': { $mod: [35, 0] } })).toStrictEqual([5])
        expect(await ids({ 'instock.qty': { $type: 'number' } })).toStrictEqual([1, 2, 3, 4, 5])
      })

      it('should complement correctly for the negative operators', async () => {
        // $ne excludes a document if ANY element matches, so it is the exact
        // complement of the positive match rather than a per-element negation.
        expect(await ids({ 'instock.qty': { $ne: 5 } })).toStrictEqual([3, 5])
        expect(await ids({ 'instock.warehouse': { $nin: ['A'] } })).toStrictEqual([2, 5])
        expect(await ids({ 'instock.qty': { $not: { $gt: 20 } } })).toStrictEqual([1, 2])
      })
    })
  }
})

/**
 * Nesting beyond one array level, and arrays of arrays of documents - the
 * cases the single-level tutorial does not reach.
 */
describe('Dotted paths across deeper nesting', () => {
  const docs = [
    { _id: 1 as any, a: { b: [{ c: 1 }, { c: 2 }] } }, // object -> array -> field
    { _id: 2 as any, a: { b: [{ c: 3 }] } },
    { _id: 3 as any, a: [{ b: { c: 1 } }] }, //            array -> object -> field
    { _id: 4 as any, a: [{ b: [{ c: 9 }] }] }, //          array -> array -> field
    { _id: 5 as any, a: { b: { c: 1 } } }, //              no arrays at all
    { _id: 6 as any, when: [{ at: new Date('2020-06-15T00:00:00.000Z') }] }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('nested').insertMany(structuredClone(docs))
    await mongo().collection('nested').insertMany(structuredClone(docs))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const ids = async (filter: any): Promise<any[]> =>
      (await db().collection('nested').find(filter).toArray()).map(d => d._id)

    describe(dbName, () => {
      it('should descend into an array at any level of the path', async () => {
        expect(await ids({ 'a.b.c': 1 })).toStrictEqual([1, 3, 5])
        expect(await ids({ 'a.b.c': 9 })).toStrictEqual([4])
        expect(await ids({ 'a.b.c': { $gte: 2 } })).toStrictEqual([1, 2, 4])
      })

      it('should match Dates through an array path', async () => {
        expect(await ids({ 'when.at': new Date('2020-06-15T00:00:00.000Z') })).toStrictEqual([6])
        expect(await ids({ 'when.at': { $gte: new Date('2020-01-01T00:00:00.000Z') } })).toStrictEqual([6])
      })
    })
  }
})
