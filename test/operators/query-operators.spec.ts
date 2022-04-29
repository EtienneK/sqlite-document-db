import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db as Mdb } from 'mongodb'

import { Db } from '../../src/index'

describe('Comparison Query Operators - https://www.mongodb.com/docs/manual/reference/operator/query-comparison/', () => {
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

    describe(dbName, () => {
      it('$eq; $ne', async () => {
        const i = [
          { _id: 1 as any, item: { name: 'ab', code: '123' }, qty: 15, tags: ['A', 'B', 'C'], nullable: null },
          { _id: 2 as any, item: { name: 'cd', code: '123' }, qty: 20, tags: ['B'], nullable: 'not null' },
          { _id: 3 as any, item: { name: 'ij', code: '456' }, qty: 25, tags: ['A', 'B'] },
          { _id: 4 as any, item: { name: 'xy', code: '456' }, qty: 30, tags: ['B', 'A'], nullable: 3 },
          { _id: 5 as any, item: { name: 'mn', code: '000' }, qty: 20, tags: [['A', 'B'], 'C'], nullable: null }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // $eq - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/eq/
        expect(await col.find({ qty: { $eq: 20 } }).toArray()).toStrictEqual([i[1], i[4]])
        expect(await col.find({ qty: 20 }).toArray()).toStrictEqual([i[1], i[4]])
        expect(await col.find({ 'item.name': { $eq: 'ab' } }).toArray()).toStrictEqual([i[0]])
        expect(await col.find({ 'item.name': 'ab' }).toArray()).toStrictEqual([i[0]])
        // TODO: Array element equal values
        // expect(await col.find({ tags: { $eq: 'B' } }).toArray()).toStrictEqual([i[0], i[1], i[2], i[3]])
        // expect(await col.find({ tags: 'B' }).toArray()).toStrictEqual([i[0], i[1], i[2], i[3]])
        // TODO: Equals an array value
        // expect(await col.find({ tags: { $eq: ['A', 'B'] } }).toArray()).toStrictEqual([i[2], i[4]])
        // expect(await col.find({ tags: ['A', 'B'] }).toArray()).toStrictEqual([i[2], i[4]])
        // TODO: Regex Match Behaviour
        // Other
        expect(await col.find({ qty: { $eq: 21 } }).toArray()).toStrictEqual([])
        expect(await col.find({ qty: 21 }).toArray()).toStrictEqual([])
        expect(await col.find({ nullable: null }).toArray()).toStrictEqual([i[0], i[2], i[4]])
        expect(await col.find({ nullable: { $eq: null } }).toArray()).toStrictEqual([i[0], i[2], i[4]])

        // $ne - Same tests as above, but with $ne
        expect(await col.find({ qty: { $ne: 20 } }).toArray()).toStrictEqual([i[0], i[2], i[3]])
        expect(await col.find({ 'item.name': { $ne: 'ab' } }).toArray()).toStrictEqual([i[1], i[2], i[3], i[4]])
        expect(await col.find({ nullable: { $ne: null } }).toArray()).toStrictEqual([i[1], i[3]])
      })

      it('$gt; $gte; $lt; $lte; $ne', async () => {
        const i = [
          { item: 'nuts', quantity: 30, carrier: { name: 'Shipit', fee: 3 }, real: 4.123 },
          { item: 'bolts', quantity: 50, carrier: { name: 'Shipit', fee: 4 }, real: null },
          { item: 'washers', quantity: 10, carrier: { name: 'Shipit', fee: 1 }, real: 12.35785443 }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // $gt- Examples from https://www.mongodb.com/docs/manual/reference/operator/query/gt/
        expect(await col.find({ quantity: { $gt: 20 } }).toArray()).toStrictEqual([i[0], i[1]])
        // TODO: Perform an Update Based on Embedded Document Fields
        // Other
        expect(await col.find({ 'carrier.fee': { $gt: 3 } }).toArray()).toStrictEqual([i[1]])
        expect(await col.find({ 'carrier.fee': { $gt: 4 } }).toArray()).toStrictEqual([])
        expect(await col.find({ real: { $gt: 4.12299 } }).toArray()).toStrictEqual([i[0], i[2]])
        expect(await col.find({ item: { $gt: 'bolts' } }).toArray()).toStrictEqual([i[0], i[2]])

        // $gte- Examples from https://www.mongodb.com/docs/manual/reference/operator/query/gte/
        expect(await col.find({ quantity: { $gte: 20 } }).toArray()).toStrictEqual([i[0], i[1]])
        // TODO: Perform an Update Based on Embedded Document Fields
        // Other
        expect(await col.find({ 'carrier.fee': { $gte: 3 } }).toArray()).toStrictEqual([i[0], i[1]])
        expect(await col.find({ 'carrier.fee': { $gte: 5 } }).toArray()).toStrictEqual([])
        expect(await col.find({ real: { $gte: 12.35785443 } }).toArray()).toStrictEqual([i[2]])
        expect(await col.find({ item: { $gte: 'bolts' } }).toArray()).toStrictEqual([i[0], i[1], i[2]])

        // $lt - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/lt/
        expect(await col.find({ quantity: { $lt: 20 } }).toArray()).toStrictEqual([i[2]])
        // TODO: Perform an Update Based on Embedded Document Fields
        // Other
        expect(await col.find({ 'carrier.fee': { $lt: 3 } }).toArray()).toStrictEqual([i[2]])
        expect(await col.find({ 'carrier.fee': { $lt: 1 } }).toArray()).toStrictEqual([])
        expect(await col.find({ real: { $lt: 4.12301 } }).toArray()).toStrictEqual([i[0]])
        expect(await col.find({ item: { $lt: 'nuts' } }).toArray()).toStrictEqual([i[1]])

        // $lte - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/lte/
        expect(await col.find({ quantity: { $lte: 20 } }).toArray()).toStrictEqual([i[2]])
        // TODO: Perform an Update Based on Embedded Document Fields
        // Other
        expect(await col.find({ 'carrier.fee': { $lte: 3 } }).toArray()).toStrictEqual([i[0], i[2]])
        expect(await col.find({ 'carrier.fee': { $lte: 0 } }).toArray()).toStrictEqual([])
        expect(await col.find({ real: { $lte: 4.123 } }).toArray()).toStrictEqual([i[0]])
        expect(await col.find({ item: { $lte: 'nuts' } }).toArray()).toStrictEqual([i[0], i[1]])

        // $ne - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/ne/
        expect(await col.find({ quantity: { $ne: 20 } }).toArray()).toStrictEqual([i[0], i[1], i[2]])
        // TODO: Perform an Update Based on Embedded Document Fields
        // Other
        expect(await col.find({ 'carrier.fee': { $ne: 3 } }).toArray()).toStrictEqual([i[1], i[2]])
        expect(await col.find({ real: { $ne: null } }).toArray()).toStrictEqual([i[0], i[2]])
        expect(await col.find({ real: { $ne: 4.123 } }).toArray()).toStrictEqual([i[1], i[2]])
        expect(await col.find({ item: { $ne: 'nuts' } }).toArray()).toStrictEqual([i[1], i[2]])
      })

      it('$in; $nin', async () => {
        const i = [
          { item: 'Pens', quantity: 350, tags: ['school', 'office'] },
          { item: 'Erasers', quantity: 15, tags: ['school', 'home'] },
          { item: 'Maps', tags: ['office', 'storage'] },
          { item: 'Books', quantity: 5, tags: ['school', 'storage', 'home'] }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // $in - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/in/
        expect(await col.find({ quantity: { $in: [5, 15] } }).toArray()).toStrictEqual([i[1], i[3]])
        // TODO: Use the $in Operator to Match Values in an Array
        // TODO: Use the $in Operator with a Regular Expression
        // Other
        expect(await col.find({ quantity: { $in: [4, 16] } }).toArray()).toStrictEqual([])
        expect(await col.find({ quantity: { $in: [null] } }).toArray()).toStrictEqual([i[2]])

        // $nin - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/nin/
        expect(await col.find({ quantity: { $nin: [5, 15] } }).toArray()).toStrictEqual([i[0], i[2]])
        // TODO: Use the $in Operator to Match Values in an Array
        // TODO: Use the $in Operator with a Regular Expression
        // Other
        expect(await col.find({ quantity: { $nin: [4, 16] } }).toArray()).toStrictEqual([i[0], i[1], i[2], i[3]])
        expect(await col.find({ quantity: { $nin: [null] } }).toArray()).toStrictEqual([i[0], i[1], i[3]])
      })
    })
  }
})
