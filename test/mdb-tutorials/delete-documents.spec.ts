import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Delete Documents - https://www.mongodb.com/docs/manual/tutorial/remove-documents/', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const items = [
    { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'P' },
    { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
  ]

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
    sqldb = await Db.fromUrl(':memory:')

    await sqldb.collection('items').insertMany(items)
    await mongodb.collection('items').insertMany(items)
  })

  afterEach(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb

    describe(dbName, () => {
      it('Should be able to delete all documents', async () => {
        // Arrange
        const query = {}
        // Act
        const actual = await db().collection('items').deleteMany(query)
        // Assert
        expect(actual.deletedCount).toStrictEqual(5)
        expect(await db().collection('items').countDocuments()).toStrictEqual(0)
        expect(await db().collection('items').find().toArray()).toStrictEqual([])
      })

      it('Should be able to delete all documents that matches a condition', async () => {
        // Arrange
        const query = { status: 'A' }
        // Act
        const actual = await db().collection('items').deleteMany(query)
        // Assert
        expect(actual.deletedCount).toStrictEqual(2)
        expect(await db().collection('items').countDocuments()).toStrictEqual(3)
        expect(await db().collection('items').find().toArray()).toStrictEqual([items[1], items[2], items[3]])
      })

      it('Should be able to delete only one document that matches a condition', async () => {
        // Arrange
        const query = { status: 'D' }
        // Act
        const actual = await db().collection('items').deleteOne(query)
        // Assert
        expect(actual.deletedCount).toStrictEqual(1)
        expect(await db().collection('items').countDocuments()).toStrictEqual(4)
        expect(await db().collection('items').find().toArray()).toStrictEqual([items[0], items[1], items[3], items[4]])
      })
    })
  }
})
