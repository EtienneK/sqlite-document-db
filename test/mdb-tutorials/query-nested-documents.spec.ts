import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

describe('Query on Embedded/Nested Documents - https://www.mongodb.com/docs/manual/tutorial/query-embedded-documents/', () => {
  const items = [
    { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
    { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { item: 'unknown', qty: 5, size: {}, status: 'E' },
    { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(items)
    await mongo().collection('items').insertMany(items)
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('Should be able to match an embedded/nested EMPTY document', async () => {
        // Arrange
        const query = { size: { } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[4]])
      })

      it('Should be able to match an embedded/nested document', async () => {
        // Arrange
        const query = { size: { h: 14, w: 21, uom: 'cm' } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[0]])
      })

      it('Should not match an embedded/nested document where fields are in the incorrect order', async () => {
        // Arrange
        const query = { size: { w: 21, h: 14, uom: 'cm' } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([])
      })

      it('Should be able to specify an equality match on a nested field', async () => {
        // Arrange
        const query = { 'size.uom': 'in' }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[1], items[2]])
      })

      it('Should be able to specify a match on a nested field using a query operator', async () => {
        // Arrange
        const query = { 'size.h': { $lt: 15 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[0], items[1], items[2], items[5]])
      })

      it('Should be able to specify a match on a nested field using a query operator with AND condition', async () => {
        // Arrange
        const query = { 'size.h': { $lt: 15 }, 'size.uom': 'in', status: 'D' }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[2]])
      })
    })
  }
})
