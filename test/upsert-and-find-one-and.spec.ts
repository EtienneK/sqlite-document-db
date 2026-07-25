import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 4's remainder: the `upsert` option and the findOneAnd* trio.
 *
 * The interesting half is what an upsert INSERTS when nothing matched. MongoDB
 * seeds the new document from the filter's equality conditions and then applies
 * the update's operators over them - and "equality condition" is a narrower
 * idea than it first looks, so most of these assertions exist to pin down
 * exactly which parts of a filter carry over.
 */
describe('upsert and findOneAnd*', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      describe('updateOne with upsert', () => {
        it('should update normally when a document matches', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, item: 'journal', qty: 25 } as any)

          const result = await col.updateOne({ item: 'journal' }, { $set: { qty: 30 } }, { upsert: true })
          expect(result.matchedCount).toStrictEqual(1)
          expect(result.modifiedCount).toStrictEqual(1)
          expect(result.upsertedCount).toStrictEqual(0)
          expect(result.upsertedId).toStrictEqual(null)
          expect(await col.countDocuments({})).toStrictEqual(1)
        })

        it('should insert when nothing matches, reporting upsertedId', async () => {
          const col = db().collection('i')

          const result = await col.updateOne({ item: 'planner' }, { $set: { qty: 5 } }, { upsert: true })
          expect(result.matchedCount).toStrictEqual(0)
          expect(result.modifiedCount).toStrictEqual(0)
          expect(result.upsertedCount).toStrictEqual(1)
          expect(result.upsertedId).not.toStrictEqual(null)

          const doc = await col.findOne({ item: 'planner' })
          expect(doc?.qty).toStrictEqual(5)
          expect(doc?._id).toStrictEqual(result.upsertedId)
        })

        it('should not insert when nothing matches and upsert is off', async () => {
          const col = db().collection('i')
          const result = await col.updateOne({ item: 'planner' }, { $set: { qty: 5 } })
          expect(result.upsertedCount).toStrictEqual(0)
          expect(await col.countDocuments({})).toStrictEqual(0)
        })

        it('should seed the new document from the filter equalities', async () => {
          const col = db().collection('i')
          await col.updateOne(
            { item: 'planner', 'size.uom': 'cm', status: { $eq: 'A' } },
            { $set: { qty: 5 } },
            { upsert: true }
          )
          const doc = await col.findOne({})
          expect(doc?.item).toStrictEqual('planner')
          expect(doc?.status).toStrictEqual('A')
          // A dotted filter path becomes a nested document
          expect(doc?.size).toStrictEqual({ uom: 'cm' })
          expect(doc?.qty).toStrictEqual(5)
        })

        it('should carry over the _id a filter pins', async () => {
          const col = db().collection('i')
          const result = await col.updateOne({ _id: 'pinned' } as any, { $set: { v: 1 } }, { upsert: true })
          expect(result.upsertedId).toStrictEqual('pinned')
          expect((await col.findOne({}))?._id).toStrictEqual('pinned')
        })

        it('should not seed from conditions that name no single value', async () => {
          const col = db().collection('i')
          // A range, an $in and a regex all match many values, so none of them
          // can contribute a field to the inserted document.
          await col.updateOne(
            { qty: { $gt: 10 }, status: { $in: ['A', 'B'] }, item: /^p/, tags: { $ne: 'x' } },
            { $set: { seeded: true } },
            { upsert: true }
          )
          const doc = await col.findOne({})
          expect(doc?.seeded).toStrictEqual(true)
          expect(doc?.qty).toStrictEqual(undefined)
          expect(doc?.status).toStrictEqual(undefined)
          expect(doc?.item).toStrictEqual(undefined)
          expect(doc?.tags).toStrictEqual(undefined)
        })

        it('should seed through $and but not through $or', async () => {
          const col = db().collection('i')
          await col.updateOne(
            { $and: [{ a: 1 }, { b: 2 }], $or: [{ c: 3 }, { c: 4 }] },
            { $set: { v: 1 } },
            { upsert: true }
          )
          const doc = await col.findOne({})
          expect(doc?.a).toStrictEqual(1)
          expect(doc?.b).toStrictEqual(2)
          expect(doc?.c).toStrictEqual(undefined)
        })

        it('$inc should count up from 0 on the inserted document', async () => {
          const col = db().collection('i')
          await col.updateOne({ item: 'planner' }, { $inc: { qty: 7 } }, { upsert: true })
          expect((await col.findOne({}))?.qty).toStrictEqual(7)
        })

        it('$setOnInsert should apply only when the upsert inserts', async () => {
          const col = db().collection('i')
          await col.updateOne(
            { item: 'planner' },
            { $set: { qty: 1 }, $setOnInsert: { createdAt: 'first' } },
            { upsert: true }
          )
          expect((await col.findOne({}))?.createdAt).toStrictEqual('first')

          // Second time it matches, so $setOnInsert must not fire
          await col.updateOne(
            { item: 'planner' },
            { $set: { qty: 2 }, $setOnInsert: { createdAt: 'second' } },
            { upsert: true }
          )
          const doc = await col.findOne({})
          expect(doc?.createdAt).toStrictEqual('first')
          expect(doc?.qty).toStrictEqual(2)
        })

        it('$setOnInsert may set _id - the document does not exist yet', async () => {
          const col = db().collection('i')
          await col.updateOne({ k: 1 }, { $setOnInsert: { _id: 'custom' } } as any, { upsert: true })
          expect(await col.findOne({})).toStrictEqual({ _id: 'custom', k: 1 })
        })

        it('should reject $setOnInsert conflicting with another operator', async () => {
          const col = db().collection('i')
          await expect(col.updateOne({ k: 1 }, { $set: { a: 1 }, $setOnInsert: { a: 2 } }, { upsert: true }))
            .rejects.toThrow()
        })

        it('an update of only $setOnInsert should be a no-op on a match', async () => {
          const col = db().collection('i')
          await col.insertOne({ _id: 1, v: 'orig' } as any)
          const result = await col.updateOne({ _id: 1 } as any, { $setOnInsert: { v: 'new' } }, { upsert: true })
          expect(result.matchedCount).toStrictEqual(1)
          expect(result.modifiedCount).toStrictEqual(0)
          expect((await col.findOne({}))?.v).toStrictEqual('orig')
        })

        it('$unset should contribute nothing to an inserted document', async () => {
          const col = db().collection('i')
          await col.updateOne({ k: 5 }, { $unset: { gone: '' } }, { upsert: true })
          const doc = await col.findOne({})
          expect(doc?.k).toStrictEqual(5)
          expect('gone' in (doc as object)).toStrictEqual(false)
        })

        it('should carry whole objects and arrays from the filter', async () => {
          const col = db().collection('i')
          await col.updateOne({ size: { h: 1, w: 2 }, tags: ['a', 'b'] }, { $set: { v: 1 } }, { upsert: true })
          const doc = await col.findOne({})
          expect(doc?.size).toStrictEqual({ h: 1, w: 2 })
          expect(doc?.tags).toStrictEqual(['a', 'b'])
        })

        it('should insert with a generated _id when the filter is empty', async () => {
          const col = db().collection('i')
          const result = await col.updateOne({}, { $set: { v: 1 } }, { upsert: true })
          expect(result.upsertedId).not.toStrictEqual(null)
          expect((await col.findOne({}))?.v).toStrictEqual(1)
        })

        it('should store Dates from the filter and the update', async () => {
          const col = db().collection('i')
          const when = new Date('2021-03-04T05:06:07.000Z')
          await col.updateOne({ at: when }, { $set: { seen: when } }, { upsert: true })
          const doc = await col.findOne({})
          expect(doc?.at).toStrictEqual(when)
          expect(doc?.seen).toStrictEqual(when)
        })
      })

      describe('updateMany with upsert', () => {
        it('should insert exactly one document when nothing matches', async () => {
          const col = db().collection('i')
          const result = await col.updateMany({ status: 'X' }, { $set: { qty: 1 } }, { upsert: true })
          expect(result.upsertedCount).toStrictEqual(1)
          expect(await col.countDocuments({})).toStrictEqual(1)
        })

        it('should update every match without inserting', async () => {
          const col = db().collection('i')
          await col.insertMany([{ status: 'A' }, { status: 'A' }] as any[])
          const result = await col.updateMany({ status: 'A' }, { $set: { qty: 1 } }, { upsert: true })
          expect(result.matchedCount).toStrictEqual(2)
          expect(result.upsertedCount).toStrictEqual(0)
          expect(await col.countDocuments({})).toStrictEqual(2)
        })
      })

      describe('replaceOne with upsert', () => {
        it('should insert the replacement when nothing matches', async () => {
          const col = db().collection('i')
          const result = await col.replaceOne({ item: 'planner' }, { item: 'planner', qty: 3 }, { upsert: true })
          expect(result.upsertedCount).toStrictEqual(1)
          expect(await col.findOne({ item: 'planner' })).toStrictEqual({ _id: result.upsertedId, item: 'planner', qty: 3 })
        })

        it('should use the _id the filter pins', async () => {
          const col = db().collection('i')
          const result = await col.replaceOne({ _id: 'pinned' } as any, { qty: 3 }, { upsert: true })
          expect(result.upsertedId).toStrictEqual('pinned')
          expect(await col.findOne({})).toStrictEqual({ _id: 'pinned', qty: 3 })
        })
      })

      // The driver overloads findOneAnd*, and intersecting those overloads with
      // this library's signatures on the `Db | Mdb` union drops the options
      // parameter, so a three-argument call stops compiling. Same reason
      // test/index.spec.ts needs byId(): what these specs pin down is runtime
      // behaviour on both engines, not the union's typing.
      const col = (): any => db().collection('i')

      describe('findOneAndUpdate', () => {
        const seed = async (): Promise<void> => {
          await col().insertMany([
            { _id: 1, item: 'journal', qty: 25 },
            { _id: 2, item: 'planner', qty: 75 }
          ] as any[])
        }

        it('should return the document as it was before by default', async () => {
          await seed()
          const doc = await col().findOneAndUpdate({ item: 'journal' }, { $set: { qty: 30 } })
          expect(doc).toStrictEqual({ _id: 1, item: 'journal', qty: 25 })
          expect((await col().findOne({ item: 'journal' }))?.qty).toStrictEqual(30)
        })

        it("should return the updated document with returnDocument 'after'", async () => {
          await seed()
          const doc = await col().findOneAndUpdate(
            { item: 'journal' }, { $set: { qty: 30 } }, { returnDocument: 'after' }
          )
          expect(doc).toStrictEqual({ _id: 1, item: 'journal', qty: 30 })
        })

        it('should return null when nothing matches', async () => {
          await seed()
          expect(await col().findOneAndUpdate({ item: 'nope' }, { $set: { qty: 1 } })).toStrictEqual(null)
        })

        it('should honour sort when choosing which document to update', async () => {
          await seed()
          const doc = await col().findOneAndUpdate(
            {}, { $set: { touched: true } }, { sort: { qty: -1 } }
          )
          expect(doc?._id).toStrictEqual(2) // the highest qty, not the first row
          expect((await col().findOne({ _id: 2 } as any))?.touched).toStrictEqual(true)
          expect((await col().findOne({ _id: 1 } as any))?.touched).toStrictEqual(undefined)
        })

        it('should apply a projection to the returned document', async () => {
          await seed()
          const doc = await col().findOneAndUpdate(
            { item: 'journal' }, { $set: { qty: 30 } }, { projection: { item: 1, _id: 0 } }
          )
          expect(doc).toStrictEqual({ item: 'journal' })
        })

        it('should upsert, returning null before and the new document after', async () => {
          expect(await col().findOneAndUpdate({ item: 'new' }, { $set: { qty: 1 } }, { upsert: true })).toStrictEqual(null)
          expect(await col().countDocuments({})).toStrictEqual(1)

          const after = await col().findOneAndUpdate(
            { item: 'other' }, { $set: { qty: 2 } }, { upsert: true, returnDocument: 'after' }
          )
          expect(after?.item).toStrictEqual('other')
          expect(after?.qty).toStrictEqual(2)
        })
      })

      describe('findOneAndReplace', () => {
        it('should return the previous document and replace it wholesale', async () => {
          await col().insertOne({ _id: 1, item: 'journal', qty: 25 } as any)

          const doc = await col().findOneAndReplace({ item: 'journal' }, { item: 'diary' })
          expect(doc).toStrictEqual({ _id: 1, item: 'journal', qty: 25 })
          expect(await col().findOne({})).toStrictEqual({ _id: 1, item: 'diary' })
        })

        it("should return the replacement with returnDocument 'after'", async () => {
          await col().insertOne({ _id: 1, item: 'journal', qty: 25 } as any)
          const doc = await col().findOneAndReplace({ item: 'journal' }, { item: 'diary' }, { returnDocument: 'after' })
          expect(doc).toStrictEqual({ _id: 1, item: 'diary' })
        })

        it('should return null when nothing matches', async () => {
          expect(await col().findOneAndReplace({ item: 'nope' }, { item: 'x' })).toStrictEqual(null)
        })

        it('should upsert when nothing matches', async () => {
          const doc = await col().findOneAndReplace(
            { item: 'nope' }, { item: 'x' }, { upsert: true, returnDocument: 'after' }
          )
          expect(doc?.item).toStrictEqual('x')
          expect(await col().countDocuments({})).toStrictEqual(1)
        })
      })

      describe('findOneAndDelete', () => {
        it('should return the deleted document', async () => {
          await col().insertMany([{ _id: 1, qty: 25 }, { _id: 2, qty: 75 }] as any[])

          expect(await col().findOneAndDelete({ _id: 1 } as any)).toStrictEqual({ _id: 1, qty: 25 })
          expect(await col().countDocuments({})).toStrictEqual(1)
        })

        it('should return null when nothing matches', async () => {
          expect(await col().findOneAndDelete({ _id: 'nope' } as any)).toStrictEqual(null)
        })

        it('should honour sort and projection', async () => {
          await col().insertMany([{ _id: 1, qty: 25 }, { _id: 2, qty: 75 }] as any[])

          const doc = await col().findOneAndDelete({}, { sort: { qty: -1 }, projection: { _id: 1 } })
          expect(doc).toStrictEqual({ _id: 2 })
          expect((await col().find({}).toArray()).map((d: any) => d._id)).toStrictEqual([1])
        })
      })
    })
  }
})
