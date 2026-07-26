import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 28's first M entry: aggregation-pipeline updates -
 * `updateOne(filter, [{ $set: ... }])` and friends (MongoDB 4.2+).
 *
 * The pipeline evaluates in JavaScript per document, through the same compiled
 * stages `aggregate()` runs - the `$expr` precedent (see compileUpdatePipeline
 * in src/aggregate.ts). Everything here is dual-engine; the change EVENTS a
 * pipeline update emits are pinned in test/change-streams.spec.ts, where the
 * replica set is.
 */
describe('pipeline updates', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      describe('updateOne', () => {
        it('should apply a computed $set', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, item: 'journal', price: 10, qty: 5 } as any)

          const result = await col.updateOne({ _id: 1 } as any, [
            { $set: { total: { $multiply: ['$price', '$qty'] }, status: 'priced' } }
          ])
          expect(result.matchedCount).toStrictEqual(1)
          expect(result.modifiedCount).toStrictEqual(1)
          expect(result.upsertedCount).toStrictEqual(0)

          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual(
            { _id: 1, item: 'journal', price: 10, qty: 5, total: 50, status: 'priced' }
          )
        })

        it('should run the stages in order', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, a: 1 } as any)

          await col.updateOne({ _id: 1 } as any, [
            { $set: { b: { $add: ['$a', 1] } } },
            { $set: { c: { $add: ['$b', 1] } } }, // sees the previous stage's output
            { $unset: 'a' }
          ])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, b: 2, c: 3 })
        })

        it('should accept $addFields, and $unset with an array of fields', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, a: 1, b: 2, c: 3 } as any)

          await col.updateOne({ _id: 1 } as any, [
            { $addFields: { d: { $add: ['$a', '$b'] } } },
            { $unset: ['a', 'b'] }
          ])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, c: 3, d: 3 })
        })

        it('should apply a $project inclusion, keeping _id', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, keep: 'yes', drop: 'no' } as any)

          await col.updateOne({ _id: 1 } as any, [{ $project: { keep: 1 } }])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, keep: 'yes' })
        })

        it('should write nested paths and whole documents', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, size: { h: 14, w: 21 } } as any)

          await col.updateOne({ _id: 1 } as any, [{ $set: { 'size.uom': 'cm', meta: { checked: true } } }])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual(
            { _id: 1, size: { h: 14, w: 21, uom: 'cm' }, meta: { checked: true } }
          )
        })

        it('should round-trip Dates through expressions', async () => {
          const col = db().collection('i')
          const created = new Date('2020-01-02T03:04:05.678Z')
          await col.insertOne({ _id: 1, created } as any)

          await col.updateOne({ _id: 1 } as any, [{ $set: { seen: '$created' } }])
          const doc = await col.findOne({ _id: 1 } as any)
          expect(doc?.seen).toStrictEqual(created)
        })

        it('should report modifiedCount 0 when the pipeline changes nothing', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)

          const result = await col.updateOne({ _id: 1 } as any, [{ $set: { qty: 5 } }])
          expect(result.matchedCount).toStrictEqual(1)
          expect(result.modifiedCount).toStrictEqual(0)
        })

        it('should reject an empty pipeline like an empty update document', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)

          await expect(col.updateOne({ _id: 1 } as any, [])).rejects.toThrow()
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 5 })
        })

        it('should remove a field whose expression evaluates to missing', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, x: 1, qty: 5 } as any)

          const result = await col.updateOne({ _id: 1 } as any, [{ $set: { x: '$nope' } }])
          expect(result.modifiedCount).toStrictEqual(1)
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 5 })
        })

        it('should remove a field set to $$REMOVE', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, x: 1, qty: 5 } as any)

          await col.updateOne({ _id: 1 } as any, [{ $set: { x: '$$REMOVE' } }])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 5 })
        })

        it('should match nothing without touching anything', async () => {
          const col = db().collection('i')
          const result = await col.updateOne({ _id: 999 } as any, [{ $set: { qty: 1 } }])
          expect(result.matchedCount).toStrictEqual(0)
          expect(result.modifiedCount).toStrictEqual(0)
          expect(await col.countDocuments({})).toStrictEqual(0)
        })
      })

      describe('updateMany', () => {
        it('should compute per-document values', async () => {
          const col = db().collection('i')
          await col.insertMany([
            { _id: 1, price: 10, qty: 2, status: 'A' },
            { _id: 2, price: 20, qty: 3, status: 'A' },
            { _id: 3, price: 30, qty: 4, status: 'D' }
          ] as any[])

          const result = await col.updateMany({ status: 'A' }, [
            { $set: { total: { $multiply: ['$price', '$qty'] } } }
          ])
          expect(result.matchedCount).toStrictEqual(2)
          expect(result.modifiedCount).toStrictEqual(2)

          const docs = await col.find({}).sort({ _id: 1 }).toArray()
          expect(docs).toStrictEqual([
            { _id: 1, price: 10, qty: 2, status: 'A', total: 20 },
            { _id: 2, price: 20, qty: 3, status: 'A', total: 60 },
            { _id: 3, price: 30, qty: 4, status: 'D' }
          ])
        })

        it('should count only the documents the pipeline changed', async () => {
          const col = db().collection('i')
          await col.insertMany([
            { _id: 1, status: 'done' },
            { _id: 2, status: 'todo' }
          ] as any[])

          const result = await col.updateMany({}, [{ $set: { status: 'done' } }])
          expect(result.matchedCount).toStrictEqual(2)
          expect(result.modifiedCount).toStrictEqual(1)
        })

        it('should use a conditional over each document', async () => {
          const col = db().collection('i')
          await col.insertMany([
            { _id: 1, qty: 2 },
            { _id: 2, qty: 20 }
          ] as any[])

          await col.updateMany({}, [
            { $set: { level: { $cond: { if: { $gte: ['$qty', 10] }, then: 'high', else: 'low' } } } }
          ])
          const docs = await col.find({}).sort({ _id: 1 }).toArray()
          expect(docs.map(doc => doc.level)).toStrictEqual(['low', 'high'])
        })
      })

      describe('upsert', () => {
        it('should seed from the filter equalities and run the pipeline over them', async () => {
          const col = db().collection('i')
          const result = await col.updateOne(
            { item: 'planner', 'size.uom': 'cm', qty: { $gt: 5 } },
            [{ $set: { status: 'new', double: { $multiply: [2, 2] } } }],
            { upsert: true }
          )
          expect(result.matchedCount).toStrictEqual(0)
          expect(result.upsertedCount).toStrictEqual(1)
          expect(result.upsertedId).not.toStrictEqual(null)

          const doc = await col.findOne({ item: 'planner' })
          expect(doc).toStrictEqual({
            _id: result.upsertedId, item: 'planner', size: { uom: 'cm' }, status: 'new', double: 4
          })
        })

        it('should let the pipeline read the seeded fields', async () => {
          const col = db().collection('i')
          await col.updateOne({ _id: 7, qty: 6 } as any, [{ $set: { twice: { $multiply: ['$qty', 2] } } }], { upsert: true })
          expect(await col.findOne({ _id: 7 } as any)).toStrictEqual({ _id: 7, qty: 6, twice: 12 })
        })

        it('should insert exactly one document from updateMany', async () => {
          const col = db().collection('i')
          const result = await col.updateMany({ kind: 'x' }, [{ $set: { seen: true } }], { upsert: true })
          expect(result.upsertedCount).toStrictEqual(1)
          expect(await col.countDocuments({})).toStrictEqual(1)
        })
      })

      describe('findOneAndUpdate', () => {
        it('should return the document before the pipeline by default', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)

          const before = await col.findOneAndUpdate({ _id: 1 } as any, [{ $set: { qty: { $add: ['$qty', 1] } } }])
          expect(before).toStrictEqual({ _id: 1, qty: 5 })
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 6 })
        })

        it("should return the pipeline's output with returnDocument 'after'", async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)

          const after = await col.findOneAndUpdate(
            { _id: 1 } as any, [{ $set: { qty: { $add: ['$qty', 1] } } }], { returnDocument: 'after' }
          )
          expect(after).toStrictEqual({ _id: 1, qty: 6 })
        })
      })

      describe('bulkWrite', () => {
        it('should take a pipeline in updateOne and updateMany entries', async () => {
          const col = db().collection('i')
          await col.insertMany([{ _id: 1, qty: 1 }, { _id: 2, qty: 2 }] as any[])

          const result = await col.bulkWrite([
            { updateOne: { filter: { _id: 1 } as any, update: [{ $set: { qty: { $add: ['$qty', 10] } } }] } },
            { updateMany: { filter: {}, update: [{ $set: { swept: true } }] } }
          ])
          expect(result.matchedCount).toStrictEqual(3)
          expect(result.modifiedCount).toStrictEqual(3)

          const docs = await col.find({}).sort({ _id: 1 }).toArray()
          expect(docs).toStrictEqual([
            { _id: 1, qty: 11, swept: true },
            { _id: 2, qty: 2, swept: true }
          ])
        })
      })

      describe('what a pipeline update refuses', () => {
        it('should reject stages that are not allowed in an update', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1 } as any)
          await expect(col.updateOne({ _id: 1 } as any, [{ $match: { _id: 1 } }])).rejects.toThrow()
          await expect(col.updateOne({ _id: 1 } as any, [{ $group: { _id: null } }])).rejects.toThrow()
          await expect(col.updateOne({ _id: 1 } as any, [{ $limit: 1 }])).rejects.toThrow()
          await expect(col.updateOne({ _id: 1 } as any, [{ $nonsense: 1 }])).rejects.toThrow()
        })

        it('should reject a stage that is not a single-operator document', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1 } as any)
          await expect(col.updateOne({ _id: 1 } as any, ['$set' as any])).rejects.toThrow()
          await expect(col.updateOne({ _id: 1 } as any, [{ $set: { a: 1 }, $unset: 'b' } as any])).rejects.toThrow()
        })

        it('should reject arrayFilters alongside a pipeline', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, grades: [1, 2] } as any)
          await expect(col.updateOne(
            { _id: 1 } as any, [{ $set: { a: 1 } }], { arrayFilters: [{ e: { $gt: 1 } }] }
          )).rejects.toThrow()
        })

        it('should reject a pipeline that alters _id', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)
          await expect(col.updateOne({ _id: 1 } as any, [{ $set: { _id: 2 } }])).rejects.toThrow()
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 5 })
        })

        it('should silently RESTORE an _id the pipeline removed, counting the row modified', async () => {
          // The server's rule, which nobody would guess: removing _id is not an
          // error - it comes back - but the row still counts as modified,
          // because the no-op comparison sees the output before the restore.
          const col = db().collection('i')
          await col.insertOne({ _id: 1, qty: 5 } as any)

          const result = await col.updateOne({ _id: 1 } as any, [{ $unset: '_id' }])
          expect(result.modifiedCount).toStrictEqual(1)
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 5 })
        })

        it('should keep _id through a $project that excludes it', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, keep: 'y', drop: 'n' } as any)

          await col.updateOne({ _id: 1 } as any, [{ $project: { keep: 1, _id: 0 } }])
          expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, keep: 'y' })
        })

        it('should surface an expression type error without writing anything', async () => {
          const col = db().collection('i')
          await col.insertMany([{ _id: 1, qty: 5 }, { _id: 2, qty: 'many' }] as any[])
          await expect(col.updateMany({}, [{ $set: { double: { $multiply: ['$qty', 2] } } }])).rejects.toThrow()
        })
      })
    })
  }
})
