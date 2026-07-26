import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

/**
 * Bulk Write Operations - https://www.mongodb.com/docs/manual/core/bulk-write-operations/
 *
 * The last gap in BACKLOG item 13, which waited on `bulkWrite()` from item 15.
 * The examples are the tutorial's own.
 */
describe('Bulk Write Operations - https://www.mongodb.com/docs/manual/core/bulk-write-operations/', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const pizzas = (): any => db().collection('pizzas')

    describe(dbName, () => {
      it('Should be able to run the tutorial\'s mixed batch', async () => {
        // Arrange - the tutorial's own operation list.
        const result = await pizzas().bulkWrite([
          { insertOne: { document: { _id: 3, type: 'beef', size: 'medium', price: 6 } } },
          { insertOne: { document: { _id: 4, type: 'sausage', size: 'large', price: 10 } } },
          { updateOne: { filter: { type: 'cheese' }, update: { $set: { price: 8 } }, upsert: true } },
          { deleteOne: { filter: { type: 'pepperoni' } } }
        ])

        // Assert
        expect(result.insertedCount).toStrictEqual(2)
        expect(result.upsertedCount).toStrictEqual(1)
        expect(result.deletedCount).toStrictEqual(0)
        expect(await pizzas().countDocuments({})).toStrictEqual(3)
      })

      it('Should stop an ordered batch at the first error', async () => {
        await pizzas().insertOne({ _id: 1, type: 'cheese' })
        await expect(pizzas().bulkWrite([
          { insertOne: { document: { _id: 2, type: 'beef' } } },
          { insertOne: { document: { _id: 1, type: 'duplicate' } } },
          { insertOne: { document: { _id: 3, type: 'never-tried' } } }
        ])).rejects.toThrow()

        expect(await pizzas().countDocuments({ _id: 2 })).toStrictEqual(1)
        expect(await pizzas().countDocuments({ _id: 3 })).toStrictEqual(0)
      })

      it('Should continue an unordered batch past the error', async () => {
        await pizzas().insertOne({ _id: 1, type: 'cheese' })
        await expect(pizzas().bulkWrite([
          { insertOne: { document: { _id: 2, type: 'beef' } } },
          { insertOne: { document: { _id: 1, type: 'duplicate' } } },
          { insertOne: { document: { _id: 3, type: 'still-tried' } } }
        ], { ordered: false })).rejects.toThrow()

        expect(await pizzas().countDocuments({ _id: 2 })).toStrictEqual(1)
        expect(await pizzas().countDocuments({ _id: 3 })).toStrictEqual(1)
      })

      it('Should update and delete many in one batch', async () => {
        await pizzas().insertMany([
          { _id: 1, type: 'cheese', price: 5 },
          { _id: 2, type: 'beef', price: 6 },
          { _id: 3, type: 'beef', price: 7 }
        ])
        const result = await pizzas().bulkWrite([
          { updateMany: { filter: { type: 'beef' }, update: { $inc: { price: 1 } } } },
          { deleteMany: { filter: { price: { $lt: 6 } } } }
        ])
        expect(result.matchedCount).toStrictEqual(2)
        expect(result.modifiedCount).toStrictEqual(2)
        expect(result.deletedCount).toStrictEqual(1)
        expect((await pizzas().find({}).sort({ _id: 1 }).toArray()).map((p: any) => p.price))
          .toStrictEqual([7, 8])
      })
    })
  }
})
