import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import Db from '../../src/index'

describe('Query Documents', () => {
  const mongod = new MongoMemoryServer()
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const data = {
    items: [
      { item: "journal", qty: 25, size: { h: 14, w: 21, uom: "cm" }, status: "A" },
      { item: "notebook", qty: 50, size: { h: 8.5, w: 11, uom: "in" }, status: "A" },
      { item: "paper", qty: 100, size: { h: 8.5, w: 11, uom: "in" }, status: "D" },
      { item: "planner", qty: 75, size: { h: 22.85, w: 30, uom: "cm" }, status: "D" },
      { item: "postcard", qty: 45, size: { h: 10, w: 15.25, uom: "cm" }, status: "A" }
    ]
  }

  beforeAll(async () => {
    mongoClient = await MongoClient.connect(await mongod.getUri())
    mongodb = mongoClient.db(await mongod.getDbName())
    sqldb = await Db.fromUrl(':memory:')

    for (const [key, value] of Object.entries(data)) {
      await sqldb.collection(key).insertMany(value)
      await mongodb.collection(key).insertMany(value)
    }
  })

  afterAll(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb

    describe(dbName + ' > Basic', () => {
      it('Should select all documents in a collection', async () => {
        // Arrange
        const query = undefined
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        expect(actual).toStrictEqual(data.items)
      })
    })

    describe(dbName + ' > Basic', () => {
      it('Should be able to specify equality condition', async () => {
        // Arrange
        const query = { status: 'D' }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [ data.items[2], data.items[3] ]
        expect(actual).toStrictEqual(expected)
      })
    })

  }

})