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
