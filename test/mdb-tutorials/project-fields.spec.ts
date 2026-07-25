import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs, seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * The compiled projection tree is keyed by user-supplied field names and looked
 * up with the DOCUMENT's field names, so an ordinary `{}` answers both from
 * Object.prototype.
 */
describe('Projection and Object.prototype', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('should not confuse a field named after an Object.prototype member', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, a: 1, toString: { b: 2 }, constructor: 'c' } as any)

        // `toString: {}` used to appear in the output: the tree lookup found
        // Object.prototype.toString and recursed into it as if it were a subtree.
        expect(await col.find({}, { projection: { a: 1 } }).toArray())
          .toStrictEqual([{ _id: 1, a: 1 }])
        expect(await col.find({}, { projection: { a: 0 } }).toArray())
          .toStrictEqual([{ _id: 1, toString: { b: 2 }, constructor: 'c' }])
      })

      it('should not pollute Object.prototype through a projection path', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, a: 1 } as any)

        // A projection spec can arrive straight from a request query string.
        await col.find({}, { projection: { '__proto__.polluted': 1 } }).toArray().catch(() => [])
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      })
    })
  }
})

describe('Project Fields to Return - https://www.mongodb.com/docs/manual/tutorial/project-fields-from-query-results/', () => {
  const items = [
    { _id: 1 as any, item: 'journal', status: 'A', size: { h: 14, w: 21, uom: 'cm' }, instock: [{ warehouse: 'A', qty: 5 }] },
    { _id: 2 as any, item: 'notebook', status: 'A', size: { h: 8.5, w: 11, uom: 'in' }, instock: [{ warehouse: 'C', qty: 5 }] },
    { _id: 3 as any, item: 'paper', status: 'D', size: { h: 8.5, w: 11, uom: 'in' }, instock: [{ warehouse: 'A', qty: 60 }] },
    { _id: 4 as any, item: 'planner', status: 'D', size: { h: 22.85, w: 30, uom: 'cm' }, instock: [{ warehouse: 'A', qty: 40 }] },
    { _id: 5 as any, item: 'postcard', status: 'A', size: { h: 10, w: 15.25, uom: 'cm' }, instock: [{ warehouse: 'B', qty: 15 }, { warehouse: 'C', qty: 35 }] }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('inventory').insertMany(structuredClone(items))
    await mongo().collection('inventory').insertMany(structuredClone(items))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('Should return only the specified fields and the _id field', async () => {
        const actual = await db().collection('inventory').find({ status: 'A' }, { projection: { item: 1, status: 1 } }).toArray()
        expect(actual).toStrictEqual([
          { _id: 1, item: 'journal', status: 'A' },
          { _id: 2, item: 'notebook', status: 'A' },
          { _id: 5, item: 'postcard', status: 'A' }
        ])
      })

      it('Should be able to suppress the _id field', async () => {
        const actual = await db().collection('inventory').find({ status: 'A' }).project({ item: 1, status: 1, _id: 0 }).toArray()
        expect(actual).toStrictEqual([
          { item: 'journal', status: 'A' },
          { item: 'notebook', status: 'A' },
          { item: 'postcard', status: 'A' }
        ])
      })

      it('Should return all but the excluded fields', async () => {
        const actual = await db().collection('inventory').find({ status: 'A' }).project({ status: 0, instock: 0 }).toArray()
        expect(actual).toStrictEqual([
          { _id: 1, item: 'journal', size: { h: 14, w: 21, uom: 'cm' } },
          { _id: 2, item: 'notebook', size: { h: 8.5, w: 11, uom: 'in' } },
          { _id: 5, item: 'postcard', size: { h: 10, w: 15.25, uom: 'cm' } }
        ])
      })

      it('Should return specific fields in embedded documents', async () => {
        const actual = await db().collection('inventory').findOne({ item: 'journal' }, { projection: { item: 1, status: 1, 'size.uom': 1 } })
        expect(actual).toStrictEqual({ _id: 1, item: 'journal', status: 'A', size: { uom: 'cm' } })
      })

      it('Should suppress specific fields in embedded documents', async () => {
        const actual = await db().collection('inventory').findOne({ item: 'journal' }, { projection: { 'size.uom': 0 } })
        expect(actual).toStrictEqual({ _id: 1, item: 'journal', status: 'A', size: { h: 14, w: 21 }, instock: [{ warehouse: 'A', qty: 5 }] })
      })

      it('Should project specific fields inside arrays of embedded documents', async () => {
        const actual = await db().collection('inventory').findOne({ item: 'postcard' }, { projection: { item: 1, status: 1, 'instock.qty': 1 } })
        expect(actual).toStrictEqual({ _id: 5, item: 'postcard', status: 'A', instock: [{ qty: 15 }, { qty: 35 }] })
      })

      it('Should reject mixing inclusion and exclusion', async () => {
        await expect(db().collection('inventory').find({}, { projection: { item: 1, status: 0 } }).toArray())
          .rejects.toThrow()
      })

      it('Should compose projection with sort and limit', async () => {
        const actual = await db().collection('inventory')
          .find({}).sort({ item: -1 }).limit(2).project({ item: 1, _id: 0 }).toArray()
        expect(actual).toStrictEqual([{ item: 'postcard' }, { item: 'planner' }])
      })

      it('An empty projection should return complete documents', async () => {
        const actual = await db().collection('inventory').findOne({ item: 'journal' }, { projection: {} })
        expect(actual).toStrictEqual(items[0])
      })
    })
  }
})
