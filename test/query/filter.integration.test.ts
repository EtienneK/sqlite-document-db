import Db from '../../src/index'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

describe('filter integration tests', () => {
  const mongod = new MongoMemoryServer()
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const items = [
    { _id: '123', item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { _id: '124', item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
    { _id: '126', item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { _id: '128', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { _id: '129', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'C' },
    { _id: '132', item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
  ]

  beforeAll(async () => {
    mongoClient = await MongoClient.connect(await mongod.getUri())
    mongodb = mongoClient.db(await mongod.getDbName())
    sqldb = await Db.fromUrl(':memory:')

    await mongodb.collection('items').insertMany(items)
    await sqldb.collection('items').insertMany(items)
  })

  afterAll(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb

    describe(dbName + '> string equality', () => {
      it('should work with single', async () => {
        const expected = [items[2], items[3]]
        const actual = await db().collection('items').find({ status: 'D' }).toArray()
        expect(actual).toStrictEqual(expected)
      })

      it('should work with multiple', async () => {
        const expected = [items[1]]
        const actual = await db().collection('items').find({ status: 'A', item: 'notebook' }).toArray()
        expect(actual).toStrictEqual(expected)
      })

      it('nesting does exact document matching', async () => {
        const expected = [items[5]]
        const actual = await db().collection('items').find({ size: { h: 10, w: 15.25, uom: 'cm' } }).toArray()
        expect(actual).toStrictEqual(expected)
      })

      it('should support nesting using the dot operator', async () => {
        const expected = [items[0], items[3], items[4], items[5]]
        const actual = await db().collection('items').find({ 'size.uom': 'cm' }).toArray()
        expect(actual).toStrictEqual(expected)
      })
    })

    describe('special cases', function () {
      it('should return all items when passed no parameters', async () => {
        const expected = items
        const actual = await db().collection('items').find().toArray()
        expect(actual).toStrictEqual(expected)
      })
    })
  }
})
