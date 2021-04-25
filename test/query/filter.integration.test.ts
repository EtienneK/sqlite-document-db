import Db from '../../src/index'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

describe('filter integration tests', () => {
  const mongod = new MongoMemoryServer()
  let mongoClient: MongoClient

  let mdb: Mdb
  let db: Db

  const items = [
    { _id: '123', item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { _id: '124', item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
    { _id: '126', item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { _id: '128', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { _id: '129', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'C' },
    { _id: '132', item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
  ]

  beforeAll(async () => {
    mongoClient = await MongoClient.connect(await mongod.getUri(), { useUnifiedTopology: true })
    mdb = mongoClient.db(await mongod.getDbName())
    db = await Db.fromUrl(':memory:')

    await mdb.collection('items').insertMany(items)
    await db.collection('items').insertMany(items)
  })

  afterAll(async () => {
    await db.close()
    await mongoClient.close()
    await mongod.stop()
  })

  describe('string equality', () => {
    it('should work with single', async () => {
      for (const toTest of [db, mdb]) {
        const expected = items[4]
        const actual = { ...(await toTest.collection('items').find({ status: 'C' }).toArray())[0] }
        expect(actual).toStrictEqual(expected)
      }
    })

    it('should work with multiple', function () {
    })

    it('nesting does exact document matching', function () {
    })

    it('should support nesting using the dot operator', function () {
    })
  })
})
