import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

describe('Update Documents - https://www.mongodb.com/docs/manual/tutorial/update-documents/', () => {
  const items = [
    { _id: undefined, item: 'canvas', qty: 100, size: { h: 28, w: 35.5, uom: 'cm' }, status: 'A' },
    { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { item: 'mat', qty: 85, size: { h: 27.9, w: 35.5, uom: 'cm' }, status: 'A' },
    { item: 'mousepad', qty: 25, size: { h: 19, w: 22.85, uom: 'cm' }, status: 'P' },
    { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'P' },
    { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' },
    { item: 'sketchbook', qty: 80, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { item: 'sketch pad', qty: 95, size: { h: 22.85, w: 30.5, uom: 'cm' }, status: 'A' }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(items)
    await mongo().collection('items').insertMany(items)
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('Should be able to update a single document using updateOne() with $set', async () => {
        // Act - example straight from the tutorial
        const actual = await db().collection('items').updateOne(
          { item: 'paper' },
          { $set: { 'size.uom': 'cm', status: 'P' } }
        )
        // Assert
        expect(actual.matchedCount).toStrictEqual(1)
        expect(actual.modifiedCount).toStrictEqual(1)
        const doc = await db().collection('items').findOne({ item: 'paper' })
        expect(doc?.size).toStrictEqual({ h: 8.5, w: 11, uom: 'cm' })
        expect(doc?.status).toStrictEqual('P')
        expect(doc?.qty).toStrictEqual(100) // untouched fields survive
      })

      it('updateOne() should only update the FIRST matching document', async () => {
        // Act - two documents have status 'P'
        const actual = await db().collection('items').updateOne(
          { status: 'P' },
          { $set: { flagged: true } }
        )
        // Assert
        expect(actual.matchedCount).toStrictEqual(1)
        expect(actual.modifiedCount).toStrictEqual(1)
        expect(await db().collection('items').countDocuments({ flagged: true })).toStrictEqual(1)
        expect((await db().collection('items').findOne({ flagged: true }))?.item).toStrictEqual('mousepad')
        // The stored value must be a real boolean, not SQLite's 1 (a $set
        // value routed through json_set as a bare integer would store 1).
        expect((await db().collection('items').findOne({ flagged: true }))?.flagged).toStrictEqual(true)
      })

      it('Should be able to update multiple documents using updateMany() with $set', async () => {
        // Act - example straight from the tutorial
        const actual = await db().collection('items').updateMany(
          { qty: { $lt: 50 } },
          { $set: { 'size.uom': 'in', status: 'P' } }
        )
        // Assert
        expect(actual.matchedCount).toStrictEqual(3)
        expect(actual.modifiedCount).toStrictEqual(3)
        expect(await db().collection('items').countDocuments({ status: 'P' })).toStrictEqual(4)
      })

      it('updateOne() should report matchedCount 1 / modifiedCount 0 for a no-op update', async () => {
        const actual = await db().collection('items').updateOne(
          { item: 'journal' },
          { $set: { status: 'A' } } // already 'A'
        )
        expect(actual.matchedCount).toStrictEqual(1)
        expect(actual.modifiedCount).toStrictEqual(0)
      })

      it('updateOne() should report matchedCount 0 when nothing matches', async () => {
        const actual = await db().collection('items').updateOne(
          { item: 'does-not-exist' },
          { $set: { status: 'X' } }
        )
        expect(actual.matchedCount).toStrictEqual(0)
        expect(actual.modifiedCount).toStrictEqual(0)
      })

      it('$inc should increment, decrement, and start missing fields at 0', async () => {
        await db().collection('items').updateOne({ item: 'journal' }, { $inc: { qty: 10, sold: 3 } })
        const doc = await db().collection('items').findOne({ item: 'journal' })
        expect(doc?.qty).toStrictEqual(35) // 25 + 10
        expect(doc?.sold).toStrictEqual(3) // missing started at 0

        await db().collection('items').updateOne({ item: 'journal' }, { $inc: { qty: -5 } })
        expect((await db().collection('items').findOne({ item: 'journal' }))?.qty).toStrictEqual(30)
      })

      it('$unset should remove fields', async () => {
        await db().collection('items').updateOne({ item: 'journal' }, { $unset: { status: '' } })
        const doc = await db().collection('items').findOne({ item: 'journal' })
        expect(doc?.status).toStrictEqual(undefined)
        expect(await db().collection('items').countDocuments({ status: { $exists: false } })).toStrictEqual(1)
      })

      it('$set, $unset and $inc should compose in a single update', async () => {
        await db().collection('items').updateOne(
          { item: 'journal' },
          { $set: { status: 'Z' }, $inc: { qty: 1 }, $unset: { size: '' } }
        )
        const doc = await db().collection('items').findOne({ item: 'journal' })
        expect(doc?.status).toStrictEqual('Z')
        expect(doc?.qty).toStrictEqual(26)
        expect(doc?.size).toStrictEqual(undefined)
      })

      it('$set should create missing parent objects for dotted paths', async () => {
        await db().collection('items').updateOne(
          { item: 'journal' },
          { $set: { 'meta.audit.by': 'me' } }
        )
        const doc = await db().collection('items').findOne({ item: 'journal' })
        expect(doc?.meta).toStrictEqual({ audit: { by: 'me' } })
      })

      it('$set should store Date values that round-trip as Dates', async () => {
        const when = new Date('2021-03-04T05:06:07.000Z')
        await db().collection('items').updateOne({ item: 'journal' }, { $set: { updatedAt: when } })
        const doc = await db().collection('items').findOne({ item: 'journal' })
        expect(doc?.updatedAt).toStrictEqual(when)
      })

      it('updateOne() should reject an update document without operators', async () => {
        await expect(db().collection('items').updateOne({ item: 'journal' }, { status: 'X' }))
          .rejects.toThrow()
      })

      it('replaceOne() should reject a replacement document with operators', async () => {
        await expect(db().collection('items').replaceOne({ item: 'journal' }, { $set: { status: 'X' } } as any))
          .rejects.toThrow()
      })

      it('Should be able to replace a document using replaceOne()', async () => {
        // Arrange
        const query = { item: 'paper' }
        const newItem = {
          item: 'paper',
          instock: [
            { warehouse: 'A', qty: 60 },
            { warehouse: 'B', qty: 40 }
          ]
        }
        // Act
        const actual = await db().collection('items').replaceOne(query, newItem)
        // Assert
        expect(actual.modifiedCount).toStrictEqual(1)
        expect(await db().collection('items').findOne({ item: 'paper' })).toStrictEqual({ ...newItem, _id: items[5]!._id })
      })
    })
  }
})
