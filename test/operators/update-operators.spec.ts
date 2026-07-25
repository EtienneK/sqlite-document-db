import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

/**
 * The array and field update operators (BACKLOG item 4's "still open" list).
 *
 * Every assertion runs against this library AND a real MongoDB, which is the
 * only practical way to get these right: the interesting rules here are all
 * unwritten ones - what `$pull` does with a document criterion, whether
 * `$addToSet` counts `1` and `true` as the same value, what `$mul` does to a
 * field that is not there. When an expectation is wrong, the Mongodb variant
 * fails too and says so.
 */
describe('Array and field update operators', () => {
  const docs = [
    { _id: 1 as any, item: 'journal', tags: ['blank', 'red'], scores: [5, 2, 9], qty: 25, label: 'A' },
    { _id: 2 as any, item: 'notebook', tags: ['red', 'blue'], scores: [8], qty: 50, label: 'B' },
    { _id: 3 as any, item: 'paper', tags: [], scores: [], qty: 100, label: 'C' },
    {
      _id: 4 as any,
      item: 'planner',
      results: [{ product: 'abc', score: 10 }, { product: 'xyz', score: 5 }, { product: 'abc', score: 7 }],
      qty: 75,
      label: 'D'
    },
    { _id: 5 as any, item: 'mixed', mixed: [1, 'two', { a: 1 }, [4], true, false, null], qty: 10, label: 'E' }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(structuredClone(docs))
    await mongo().collection('items').insertMany(structuredClone(docs))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const items = (): any => db().collection('items')
    const find = async (id: number): Promise<any> => await items().findOne({ _id: id })

    describe(dbName, () => {
      // ------------------------------------------------------------------ $push
      describe('$push', () => {
        it('should append a single value', async () => {
          await items().updateOne({ _id: 1 }, { $push: { tags: 'green' } })
          expect((await find(1)).tags).toStrictEqual(['blank', 'red', 'green'])
        })

        it('should create the array when the field is missing', async () => {
          await items().updateOne({ _id: 1 }, { $push: { colours: 'green' } })
          expect((await find(1)).colours).toStrictEqual(['green'])
        })

        it('should create missing parents for a dotted path', async () => {
          await items().updateOne({ _id: 1 }, { $push: { 'meta.audit.log': 'created' } })
          expect((await find(1)).meta).toStrictEqual({ audit: { log: ['created'] } })
        })

        it('should push a whole document as one element, not merge it', async () => {
          await items().updateOne({ _id: 1 }, { $push: { tags: { name: 'x' } } })
          expect((await find(1)).tags).toStrictEqual(['blank', 'red', { name: 'x' }])
        })

        it('should append every value of $each, in order', async () => {
          await items().updateOne({ _id: 1 }, { $push: { tags: { $each: ['green', 'black'] } } })
          expect((await find(1)).tags).toStrictEqual(['blank', 'red', 'green', 'black'])
        })

        it('should treat $each: [] as a no-op that still creates a missing array', async () => {
          const result = await items().updateOne({ _id: 1 }, { $push: { tags: { $each: [] } } })
          expect(result.modifiedCount).toStrictEqual(0)
          await items().updateOne({ _id: 1 }, { $push: { fresh: { $each: [] } } })
          expect((await find(1)).fresh).toStrictEqual([])
        })

        it('should keep the last n elements with a negative $slice', async () => {
          await items().updateOne({ _id: 1 }, { $push: { scores: { $each: [1], $slice: -2 } } })
          expect((await find(1)).scores).toStrictEqual([9, 1])
        })

        it('should keep the first n elements with a positive $slice', async () => {
          await items().updateOne({ _id: 1 }, { $push: { scores: { $each: [1], $slice: 2 } } })
          expect((await find(1)).scores).toStrictEqual([5, 2])
        })

        it('should empty the array with $slice: 0', async () => {
          await items().updateOne({ _id: 1 }, { $push: { scores: { $each: [1], $slice: 0 } } })
          expect((await find(1)).scores).toStrictEqual([])
        })

        it('should sort scalars with $sort: 1 / -1', async () => {
          await items().updateOne({ _id: 1 }, { $push: { scores: { $each: [7], $sort: 1 } } })
          expect((await find(1)).scores).toStrictEqual([2, 5, 7, 9])
          await items().updateOne({ _id: 1 }, { $push: { scores: { $each: [], $sort: -1 } } })
          expect((await find(1)).scores).toStrictEqual([9, 7, 5, 2])
        })

        it('should sort documents by a field, then slice - the leaderboard idiom', async () => {
          await items().updateOne({ _id: 4 }, {
            $push: { results: { $each: [{ product: 'new', score: 8 }], $sort: { score: -1 }, $slice: 3 } }
          })
          expect((await find(4)).results).toStrictEqual([
            { product: 'abc', score: 10 },
            { product: 'new', score: 8 },
            { product: 'abc', score: 7 }
          ])
        })

        it('should store a pushed Date as a Date', async () => {
          const when = new Date('2021-03-04T05:06:07.000Z')
          await items().updateOne({ _id: 1 }, { $push: { log: when } })
          expect((await find(1)).log).toStrictEqual([when])
        })

        it('should preserve element types through a $slice rebuild', async () => {
          await items().updateOne({ _id: 5 }, { $push: { mixed: { $each: [], $slice: -4 } } })
          expect((await find(5)).mixed).toStrictEqual([[4], true, false, null])
        })

        it('should push a large $each list', async () => {
          // One json_insert per value nests one SQL call per element, and
          // SQLite's parser gives up at a few hundred ("Recursion limit"), so
          // the list is bound as one JSON array instead. 2000 is well past
          // where the nested form died.
          const many = Array.from({ length: 2000 }, (_, i) => i)
          await items().updateOne({ _id: 3 }, { $push: { scores: { $each: many } } })
          const scores = (await find(3)).scores
          expect(scores).toHaveLength(2000)
          expect(scores[0]).toStrictEqual(0)
          expect(scores[1999]).toStrictEqual(1999)
        })

        it('should reject a push onto a non-array field, leaving it alone', async () => {
          await expect(items().updateOne({ _id: 1 }, { $push: { qty: 1 } })).rejects.toThrow()
          expect((await find(1)).qty).toStrictEqual(25)
        })
      })

      // -------------------------------------------------------------- $addToSet
      describe('$addToSet', () => {
        it('should add a value that is not present', async () => {
          await items().updateOne({ _id: 1 }, { $addToSet: { tags: 'green' } })
          expect((await find(1)).tags).toStrictEqual(['blank', 'red', 'green'])
        })

        it('should do nothing when the value is already present', async () => {
          const result = await items().updateOne({ _id: 1 }, { $addToSet: { tags: 'red' } })
          expect(result.modifiedCount).toStrictEqual(0)
          expect((await find(1)).tags).toStrictEqual(['blank', 'red'])
        })

        it('should create the array when the field is missing', async () => {
          await items().updateOne({ _id: 1 }, { $addToSet: { colours: 'green' } })
          expect((await find(1)).colours).toStrictEqual(['green'])
        })

        it('should add each new value of $each and skip duplicates within it', async () => {
          await items().updateOne({ _id: 1 }, { $addToSet: { tags: { $each: ['red', 'green', 'green'] } } })
          expect((await find(1)).tags).toStrictEqual(['blank', 'red', 'green'])
        })

        it('should compare documents by value, not by identity', async () => {
          await items().updateOne({ _id: 5 }, { $addToSet: { mixed: { a: 1 } } })
          expect((await find(5)).mixed).toStrictEqual([1, 'two', { a: 1 }, [4], true, false, null])
          await items().updateOne({ _id: 5 }, { $addToSet: { mixed: { a: 2 } } })
          expect((await find(5)).mixed).toHaveLength(8)
        })

        it('should not treat 1 and true as the same value', async () => {
          await items().updateOne({ _id: 5 }, { $addToSet: { flags: true } })
          await items().updateOne({ _id: 5 }, { $addToSet: { flags: 1 } })
          expect((await find(5)).flags).toStrictEqual([true, 1])
        })

        it('should reject an addToSet onto a non-array field', async () => {
          await expect(items().updateOne({ _id: 1 }, { $addToSet: { qty: 1 } })).rejects.toThrow()
        })
      })

      // ------------------------------------------------------------------- $pop
      describe('$pop', () => {
        it('should remove the last element with 1', async () => {
          await items().updateOne({ _id: 1 }, { $pop: { scores: 1 } })
          expect((await find(1)).scores).toStrictEqual([5, 2])
        })

        it('should remove the first element with -1', async () => {
          await items().updateOne({ _id: 1 }, { $pop: { scores: -1 } })
          expect((await find(1)).scores).toStrictEqual([2, 9])
        })

        it('should be a no-op on an empty array and on a missing field', async () => {
          expect((await items().updateOne({ _id: 3 }, { $pop: { scores: 1 } })).modifiedCount).toStrictEqual(0)
          expect((await find(3)).scores).toStrictEqual([])
          expect((await items().updateOne({ _id: 3 }, { $pop: { nope: 1 } })).modifiedCount).toStrictEqual(0)
          expect((await find(3)).nope).toStrictEqual(undefined)
        })

        it('should reject anything other than 1 or -1', async () => {
          await expect(items().updateOne({ _id: 1 }, { $pop: { scores: 2 } })).rejects.toThrow()
        })

        it('should reject a pop on a non-array field', async () => {
          await expect(items().updateOne({ _id: 1 }, { $pop: { qty: 1 } })).rejects.toThrow()
        })
      })

      // ------------------------------------------------------- $pull / $pullAll
      describe('$pull', () => {
        it('should remove every element equal to a scalar', async () => {
          await items().updateOne({ _id: 2 }, { $pull: { tags: 'red' } })
          expect((await find(2)).tags).toStrictEqual(['blue'])
        })

        it('should remove every element matching an operator criterion', async () => {
          await items().updateOne({ _id: 1 }, { $pull: { scores: { $gte: 5 } } })
          expect((await find(1)).scores).toStrictEqual([2])
        })

        it('should treat a document criterion as a query over each element', async () => {
          await items().updateOne({ _id: 4 }, { $pull: { results: { score: 7 } } })
          expect((await find(4)).results).toStrictEqual([
            { product: 'abc', score: 10 },
            { product: 'xyz', score: 5 }
          ])
        })

        it('should require every condition of a document criterion to hold', async () => {
          await items().updateOne({ _id: 4 }, { $pull: { results: { product: 'abc', score: { $lt: 8 } } } })
          expect((await find(4)).results).toStrictEqual([
            { product: 'abc', score: 10 },
            { product: 'xyz', score: 5 }
          ])
        })

        it('should be a no-op on a missing field rather than creating it', async () => {
          await items().updateOne({ _id: 1 }, { $pull: { nope: 'x' } })
          expect('nope' in (await find(1))).toStrictEqual(false)
        })

        it('should preserve the types of the elements it keeps', async () => {
          await items().updateOne({ _id: 5 }, { $pull: { mixed: 'two' } })
          expect((await find(5)).mixed).toStrictEqual([1, { a: 1 }, [4], true, false, null])
        })

        it('should reject a pull on a non-array field', async () => {
          await expect(items().updateOne({ _id: 1 }, { $pull: { qty: 1 } })).rejects.toThrow()
        })
      })

      describe('$pullAll', () => {
        it('should remove every instance of every listed value', async () => {
          await items().updateOne({ _id: 1 }, { $pullAll: { scores: [5, 9] } })
          expect((await find(1)).scores).toStrictEqual([2])
        })

        it('should not apply query semantics to its arguments', async () => {
          // $gte is a VALUE here, not an operator, so nothing matches it.
          await items().updateOne({ _id: 1 }, { $pullAll: { scores: [{ $gte: 5 }] } })
          expect((await find(1)).scores).toStrictEqual([5, 2, 9])
        })

        it('should reject a non-array argument', async () => {
          await expect(items().updateOne({ _id: 1 }, { $pullAll: { scores: 5 } })).rejects.toThrow()
        })
      })

      // ---------------------------------------------------- $mul / $min / $max
      describe('$mul', () => {
        it('should multiply an existing number', async () => {
          await items().updateOne({ _id: 1 }, { $mul: { qty: 3 } })
          expect((await find(1)).qty).toStrictEqual(75)
        })

        it('should create a missing field as 0', async () => {
          await items().updateOne({ _id: 1 }, { $mul: { missing: 5 } })
          expect((await find(1)).missing).toStrictEqual(0)
        })

        it('should reject a non-numeric target and leave it alone', async () => {
          await expect(items().updateOne({ _id: 1 }, { $mul: { item: 2 } })).rejects.toThrow()
          expect((await find(1)).item).toStrictEqual('journal')
        })
      })

      describe('$min / $max', () => {
        it('$min should replace only a larger value', async () => {
          await items().updateOne({ _id: 1 }, { $min: { qty: 10 } })
          expect((await find(1)).qty).toStrictEqual(10)
          await items().updateOne({ _id: 1 }, { $min: { qty: 99 } })
          expect((await find(1)).qty).toStrictEqual(10)
        })

        it('$max should replace only a smaller value', async () => {
          await items().updateOne({ _id: 1 }, { $max: { qty: 99 } })
          expect((await find(1)).qty).toStrictEqual(99)
          await items().updateOne({ _id: 1 }, { $max: { qty: 10 } })
          expect((await find(1)).qty).toStrictEqual(99)
        })

        it('should set a missing field outright', async () => {
          await items().updateOne({ _id: 1 }, { $min: { floor: 5 } })
          expect((await find(1)).floor).toStrictEqual(5)
        })

        it('should compare Dates chronologically', async () => {
          const early = new Date('2019-06-01T00:00:00.000Z')
          const late = new Date('2021-06-01T00:00:00.000Z')
          await items().updateOne({ _id: 1 }, { $set: { seen: late } })
          await items().updateOne({ _id: 1 }, { $min: { seen: early } })
          expect((await find(1)).seen).toStrictEqual(early)
          await items().updateOne({ _id: 1 }, { $min: { seen: late } })
          expect((await find(1)).seen).toStrictEqual(early)
        })

        it('should compare strings, and rank a number below a string', async () => {
          await items().updateOne({ _id: 1 }, { $max: { label: 'Z' } })
          expect((await find(1)).label).toStrictEqual('Z')
          // BSON order puts every number below every string, so $min against a
          // number wins over any string.
          await items().updateOne({ _id: 1 }, { $min: { label: 1 } })
          expect((await find(1)).label).toStrictEqual(1)
        })
      })

      // ---------------------------------------------------------------- $rename
      describe('$rename', () => {
        it('should move a field, keeping its value', async () => {
          await items().updateOne({ _id: 1 }, { $rename: { item: 'name' } })
          const doc = await find(1)
          expect(doc.name).toStrictEqual('journal')
          expect('item' in doc).toStrictEqual(false)
        })

        it('should move a whole array or document intact', async () => {
          await items().updateOne({ _id: 1 }, { $rename: { tags: 'labels' } })
          expect((await find(1)).labels).toStrictEqual(['blank', 'red'])
        })

        it('should overwrite an existing target', async () => {
          await items().updateOne({ _id: 1 }, { $rename: { item: 'label' } })
          expect((await find(1)).label).toStrictEqual('journal')
        })

        it('should be a no-op when the source is missing', async () => {
          const result = await items().updateOne({ _id: 1 }, { $rename: { nope: 'somewhere' } })
          expect(result.modifiedCount).toStrictEqual(0)
          expect('somewhere' in (await find(1))).toStrictEqual(false)
        })

        it('should rename into and out of nested paths', async () => {
          await items().updateOne({ _id: 1 }, { $rename: { item: 'meta.name' } })
          expect((await find(1)).meta).toStrictEqual({ name: 'journal' })
          await items().updateOne({ _id: 1 }, { $rename: { 'meta.name': 'back' } })
          expect((await find(1)).back).toStrictEqual('journal')
        })

        it('should reject renaming a field onto itself or onto its own path', async () => {
          await expect(items().updateOne({ _id: 1 }, { $rename: { item: 'item' } })).rejects.toThrow()
          await expect(items().updateOne({ _id: 1 }, { $rename: { 'a.b': 'a.b.c' } })).rejects.toThrow()
        })

        it('should reject renaming _id', async () => {
          await expect(items().updateOne({ _id: 1 }, { $rename: { _id: 'other' } })).rejects.toThrow()
          await expect(items().updateOne({ _id: 1 }, { $rename: { item: '_id' } })).rejects.toThrow()
        })
      })

      // ------------------------------------------------------ composition, bulk
      describe('composition', () => {
        it('should apply several operators in one update', async () => {
          await items().updateOne({ _id: 1 }, {
            $push: { tags: 'green' },
            $inc: { qty: 5 },
            $rename: { item: 'name' },
            $pop: { scores: 1 }
          })
          const doc = await find(1)
          expect(doc.tags).toStrictEqual(['blank', 'red', 'green'])
          expect(doc.qty).toStrictEqual(30)
          expect(doc.name).toStrictEqual('journal')
          expect(doc.scores).toStrictEqual([5, 2])
        })

        it('should reject two operators targeting the same path', async () => {
          await expect(items().updateOne({ _id: 1 }, { $push: { tags: 'x' }, $pull: { tags: 'red' } })).rejects.toThrow()
          await expect(items().updateOne({ _id: 1 }, { $rename: { item: 'label' }, $set: { label: 'X' } })).rejects.toThrow()
        })

        it('should apply to every matching document in updateMany', async () => {
          const result = await items().updateMany({ qty: { $gte: 50 } }, { $push: { audit: 'seen' } })
          expect(result.modifiedCount).toStrictEqual(3)
          expect((await find(2)).audit).toStrictEqual(['seen'])
          expect((await find(3)).audit).toStrictEqual(['seen'])
          expect((await find(4)).audit).toStrictEqual(['seen'])
          expect('audit' in (await find(1))).toStrictEqual(false)
        })
      })

      // ----------------------------------------------------------------- upsert
      describe('upsert', () => {
        it('should build the array a $push implies', async () => {
          await items().updateOne({ item: 'new' }, { $push: { tags: { $each: ['a', 'b'] } } }, { upsert: true })
          expect((await items().findOne({ item: 'new' })).tags).toStrictEqual(['a', 'b'])
        })

        it('should apply $sort and $slice on the inserted document too', async () => {
          await items().updateOne({ item: 'new' }, { $push: { s: { $each: [3, 1, 2], $sort: 1, $slice: 2 } } }, { upsert: true })
          expect((await items().findOne({ item: 'new' })).s).toStrictEqual([1, 2])
        })

        it('should dedupe an inserted $addToSet', async () => {
          await items().updateOne({ item: 'new' }, { $addToSet: { t: { $each: ['a', 'a', 'b'] } } }, { upsert: true })
          expect((await items().findOne({ item: 'new' })).t).toStrictEqual(['a', 'b'])
        })

        it('should seed $mul as 0 and $min/$max as their argument', async () => {
          await items().updateOne({ item: 'new' }, { $mul: { z: 5 }, $max: { m: 7 } }, { upsert: true })
          const doc = await items().findOne({ item: 'new' })
          expect(doc.z).toStrictEqual(0)
          expect(doc.m).toStrictEqual(7)
        })

        it('should ignore the removal operators when inserting', async () => {
          await items().updateOne({ item: 'new' }, { $set: { a: 1 }, $pull: { gone: 'x' }, $pop: { alsoGone: 1 } }, { upsert: true })
          const doc = await items().findOne({ item: 'new' })
          expect(doc.a).toStrictEqual(1)
          expect('gone' in doc).toStrictEqual(false)
          expect('alsoGone' in doc).toStrictEqual(false)
        })
      })

      // ------------------------------------------------------------ findOneAnd*
      it('findOneAndUpdate should apply the array operators and honour returnDocument', async () => {
        const after = await items().findOneAndUpdate(
          { _id: 1 }, { $push: { tags: 'green' } }, { returnDocument: 'after' }
        )
        expect(after?.tags).toStrictEqual(['blank', 'red', 'green'])
      })
    })
  }
})
