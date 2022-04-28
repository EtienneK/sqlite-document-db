import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Query an Array - https://www.mongodb.com/docs/manual/tutorial/query-arrays/', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const items = [
    { item: 'journal', qty: 25, tags: ['blank', 'red'], dim_cm: [14, 21] },
    { item: 'notebook', qty: 50, tags: ['red', 'blank'], dim_cm: [14, 21] },
    { item: 'paper', qty: 100, tags: ['red', 'blank', 'plain'], dim_cm: [14, 21] },
    { item: 'planner', qty: 75, tags: ['blank', 'red'], dim_cm: [22.85, 30] },
    { item: 'postcard', qty: 45, tags: ['blue'], dim_cm: [10, 15.25] }
  ]

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
    sqldb = await Db.fromUrl(':memory:')

    await sqldb.collection('items').insertMany(items)
    await mongodb.collection('items').insertMany(items)
  })

  afterAll(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb

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
