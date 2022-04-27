import { Db } from '../../src/index'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

describe('filter integration tests', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  const items = [
    { _id: '123' as any, item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
    { _id: '124', item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
    { _id: '126', item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
    { _id: '128', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
    { _id: '129', item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'C' },
    { _id: '132', item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
  ]

  const users = [
    { username: 'su', roles: ['admin'] },
    { username: 'etiko', roles: ['admin', 'user'] },
    { username: 'sys', roles: ['system'] }
  ]

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
    sqldb = await Db.fromUrl(':memory:')

    await sqldb.collection('items').insertMany(items)
    await mongodb.collection('items').insertMany(items)

    await sqldb.collection('users').insertMany(users)
    await mongodb.collection('users').insertMany(users)
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

    describe(dbName + '> array equality', function () {
      it('should use =', async () => {
        const expected = [users[0]]
        const actual = await db().collection('users').find({ roles: ['admin'] }).toArray()
        expect(actual).toStrictEqual(expected)
      })
      it('should matching numeric indexes', async () => {
        const expected = [users[0], users[1]]
        const actual = await db().collection('users').find({ 'roles.0': 'admin' }).toArray()
        expect(actual).toStrictEqual(expected)
      })
      it('support element matching', async () => {
        const expected = [users[0], users[1]]
        const actual = await db().collection('users').find({ roles: { $elemMatch: { $eq: 'admin' } } }).toArray()
        expect(actual).toStrictEqual(expected)
      })
    })

    describe(dbName + '> special cases', function () {
      it('should return all items when passed no parameters', async () => {
        const expected = items
        const actual = await db().collection('items').find().toArray()
        expect(actual).toStrictEqual(expected)
      })
    })
  }
})
