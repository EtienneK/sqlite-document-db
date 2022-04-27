import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Insert Documents - https://www.mongodb.com/docs/manual/tutorial/insert-documents/', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
    sqldb = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb

    it('Insert a Single Document', async () => {
      // Arrange
      const item = { _id: undefined, item: 'canvas', qty: 100, tags: ['cotton'], size: { h: 28, w: 35.5, uom: 'cm' } }
      // Act
      const actual = await db().collection('inventory').insertOne(item)
      // Assert
      expect(actual.insertedId).toBeDefined()
      expect(item._id).toBeDefined()
      expect(actual.insertedId).toStrictEqual(item._id)
      const actualItems = await db().collection('inventory').find().toArray()
      expect(actualItems).toStrictEqual([item])
    })

    it('Insert Multiple Documents', async () => {
      // Arrange
      const items = [
        { _id: undefined, item: 'journal', qty: 25, tags: ['blank', 'red'], size: { h: 14, w: 21, uom: 'cm' } },
        { item: 'mat', qty: 85, tags: ['gray'], size: { h: 27.9, w: 35.5, uom: 'cm' } },
        { item: 'mousepad', qty: 25, tags: ['gel', 'blue'], size: { h: 19, w: 22.85, uom: 'cm' } }
      ]
      // Act
      const actual = await db().collection('inventory').insertMany(items)
      // Assert
      expect(actual.insertedIds).toBeDefined()
      expect(items[0]._id).toBeDefined()
      expect(items[1]._id).toBeDefined()
      expect(items[2]._id).toBeDefined()
      expect(actual.insertedCount).toStrictEqual(3)
      const actualItems = await db().collection('inventory').find().toArray()
      expect(actualItems).toStrictEqual(items)
      expect(actualItems.length).toStrictEqual(3)
      expect(actual.insertedIds).toStrictEqual({
        0: items[0]._id,
        1: items[1]._id,
        2: items[2]._id
      })
    })
  }
})
