import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

describe('Query an Array - https://www.mongodb.com/docs/manual/tutorial/query-arrays/', () => {
  const items = [{ item: null }, { }]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(items)
    await mongo().collection('items').insertMany(items)
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('Should be able to match null using an equality filter', async () => {
        // Arrange
        const query = { item: null }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual(items)
      })

      it('Should be able to do an existence check using $exists', async () => {
        // Arrange
        const query = { item: { $exists: false } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual([items[1]])
      })
    })
  }
})
