import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Query Documents', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const data = {
    items: [
      { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
      { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
      { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
      { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'C' },
      { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
      { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
    ]
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
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

    describe(dbName + ' > Equality Conditions', () => {
      it('Should be able to specify equality condition using no explicit operator', async () => {
        // Arrange
        const query = { status: 'D' }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[2], data.items[4]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $in operator', async () => {
        // Arrange
        const query = { status: { $in: ['A', 'D'] } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0], data.items[1], data.items[2], data.items[4], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $lt operator', async () => {
        // Arrange
        const query = { qty: { $lt: 30 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $gt operator', async () => {
        // Arrange
        const query = { qty: { $gt: 30 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[1], data.items[2], data.items[3], data.items[4], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $lte operator', async () => {
        // Arrange
        const query = { qty: { $lte: 45 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0], data.items[3], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $gte operator', async () => {
        // Arrange
        const query = { qty: { $gte: 45 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[1], data.items[2], data.items[3], data.items[4], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $eq operator', async () => {
        // Arrange
        const query = { qty: { $eq: 45 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[3], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to query using $ne operator', async () => {
        // Arrange
        const query = { qty: { $ne: 45 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0], data.items[1], data.items[2], data.items[4]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to specify AND conditions', async () => {
        // Arrange
        const query = { status: 'A', qty: { $lt: 30 } }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0]]
        expect(actual).toStrictEqual(expected)
      })

      it('Should be able to specify OR conditions', async () => {
        // Arrange
        const query = { $or: [{ status: 'A' }, { qty: { $lt: 30 } }] }
        // Act
        const actual = await db().collection('items').find(query).toArray()
        // Assert
        const expected = [data.items[0], data.items[1], data.items[5]]
        expect(actual).toStrictEqual(expected)
      })
    })
  }
})
