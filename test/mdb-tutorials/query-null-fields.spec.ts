import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Query an Array - https://www.mongodb.com/docs/manual/tutorial/query-arrays/', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const items = [{ item: null }, { }]

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
