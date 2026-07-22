import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

describe('Query an Array - https://www.mongodb.com/docs/manual/tutorial/query-arrays/', () => {
  const items = [
    { item: 'journal', qty: 25, tags: ['blank', 'red'], dim_cm: [14, 21] },
    { item: 'notebook', qty: 50, tags: ['red', 'blank'], dim_cm: [14, 21] },
    { item: 'paper', qty: 100, tags: ['red', 'blank', 'plain'], dim_cm: [14, 21] },
    { item: 'planner', qty: 75, tags: ['blank', 'red'], dim_cm: [22.85, 30] },
    { item: 'postcard', qty: 45, tags: ['blue'], dim_cm: [10, 15.25] }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(items)
    await mongo().collection('items').insertMany(items)
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('Should be able to match an array exactly', async () => {
        // Arrange
        const query = { tags: ['red', 'blank'] }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[1]])
      })

      it('Should be able to match an array without regard to order or other elements using $all', async () => {
        // Arrange
        const query = { tags: { $all: ['red', 'blank', 'red'] } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[0], items[1], items[2], items[3]])
      })

      it('Should be able to query an array for a single element', async () => {
        // Arrange
        const query = { tags: 'red' }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[0], items[1], items[2], items[3]])
      })

      it('Should be able to query an array with a comparison operator on its elements', async () => {
        // Arrange
        const query = { dim_cm: { $gt: 25 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[3]])
      })

      it('Should match compound filter conditions with different elements satisfying each', async () => {
        // Arrange - one element can satisfy $gt and ANOTHER element $lt
        const query = { dim_cm: { $gt: 15, $lt: 20 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[0], items[1], items[2], items[4]])
      })

      it('Should be able to match array elements using $in', async () => {
        // Arrange
        const query = { tags: { $in: ['plain', 'blue'] } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[2], items[4]])
      })

      it('Should exclude documents whose array contains any $nin value', async () => {
        // Arrange
        const query = { tags: { $nin: ['red'] } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[4]])
      })

      it('Should be able to query for an element by the array index position', async () => {
        // Arrange
        const query = { 'dim_cm.1': { $gt: 25 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[3]])
      })

      it('Should be able to query an array by array length', async () => {
        // Arrange
        const query = { tags: { $size: 3 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[2]])
      })
    })
  }
})
