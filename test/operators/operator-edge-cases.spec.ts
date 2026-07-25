import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

/**
 * Edge cases the operator specs did not pin down, each one a bug found during
 * a review of the query compiler. They are grouped here rather than scattered
 * because they share a theme: a filter that MongoDB answers precisely (or
 * rejects outright) used to be answered wrongly, or to fail with a raw SQLite
 * error - a SQL syntax error, "malformed JSON", or a stack overflow.
 *
 * As everywhere in this suite, MongoDB is the oracle: if an assertion here is
 * wrong, the Mongodb variant fails too.
 */
describe('Query operator edge cases', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('$exists should count empty arrays and empty objects as present', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, v: 1 },
          { _id: 2, v: [] }, // <- counting json_each ROWS reported these two...
          { _id: 3, v: {} }, // <- ...as missing, because they expand to no rows
          { _id: 4, v: null },
          { _id: 5, v: '' },
          { _id: 6 }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        expect((await col.find({ v: { $exists: true } }).toArray()).map(d => d._id)).toStrictEqual([1, 2, 3, 4, 5])
        expect((await col.find({ v: { $exists: false } }).toArray()).map(d => d._id)).toStrictEqual([6])
        expect((await col.find({ v: { $not: { $exists: true } } }).toArray()).map(d => d._id)).toStrictEqual([6])
      })

      it('$size should only ever match arrays', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, v: [] },
          { _id: 2, v: ['a'] },
          { _id: 3, v: ['a', 'b'] },
          { _id: 4, v: 'not an array' },
          { _id: 5, v: 0 },
          { _id: 6 }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // The scalar, the number and the missing field are NOT size-0 arrays.
        expect((await col.find({ v: { $size: 0 } }).toArray()).map(d => d._id)).toStrictEqual([1])
        expect((await col.find({ v: { $size: 2 } }).toArray()).map(d => d._id)).toStrictEqual([3])
        expect(await col.find({ v: { $size: 9 } }).toArray()).toStrictEqual([])
        // A negative or fractional size is an error, not an empty result
        await expect(col.find({ v: { $size: -1 } }).toArray()).rejects.toThrow()
        await expect(col.find({ v: { $size: 1.5 } }).toArray()).rejects.toThrow()
      })

      it('$all should work when the field holds a scalar in some documents', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, tags: ['red', 'blank'] },
          { _id: 2, tags: 'red' }, // a bare string here used to fail the WHOLE
          { _id: 3, tags: ['red'] }, //   query with SQLite's "malformed JSON"
          { _id: 4, tags: 42 },
          { _id: 5 }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // $all is an $and of its values, so a single value also matches a scalar
        expect((await col.find({ tags: { $all: ['red'] } }).toArray()).map(d => d._id)).toStrictEqual([1, 2, 3])
        expect((await col.find({ tags: { $all: ['red', 'blank'] } }).toArray()).map(d => d._id)).toStrictEqual([1])
        expect((await col.find({ tags: { $all: ['red', 'red'] } }).toArray()).map(d => d._id)).toStrictEqual([1, 2, 3])
        expect(await col.find({ tags: { $all: [] } }).toArray()).toStrictEqual([])
      })

      it('$all should match Date elements', async () => {
        const early = new Date('2020-01-01T00:00:00.000Z')
        const late = new Date('2021-06-30T12:00:00.000Z')
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, at: [early, late] },
          { _id: 2, at: [early] },
          { _id: 3, at: early }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        expect((await col.find({ at: { $all: [early] } }).toArray()).map(d => d._id)).toStrictEqual([1, 2, 3])
        expect((await col.find({ at: { $all: [early, late] } }).toArray()).map(d => d._id)).toStrictEqual([1])
      })

      it('$elemMatch with an empty criterion should match document and array elements', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, v: [1] },
          { _id: 2, v: [] },
          { _id: 3, v: 'scalar' },
          { _id: 4 },
          { _id: 5, v: [{}] },
          { _id: 6, v: [{ a: 1 }] },
          { _id: 7, v: [[1]] },
          { _id: 8, v: [null] },
          { _id: 9, v: [new Date('2020-01-01T00:00:00.000Z')] }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // An empty criterion is an object match: only documents and arrays
        // satisfy it - scalars, nulls and Dates do not. (This used to compile
        // to `$and: []` and fail with a SQL syntax error.)
        expect((await col.find({ v: { $elemMatch: {} } }).toArray()).map(d => d._id)).toStrictEqual([5, 6, 7])
      })

      it('$in and $nin with an empty list should match nothing and everything', async () => {
        const i = [{ _id: 1 as any, v: 1 }, { _id: 2, v: 2 }]
        const col = db().collection('i')
        await col.insertMany(i)

        expect(await col.find({ v: { $in: [] } }).toArray()).toStrictEqual([])
        expect((await col.find({ v: { $nin: [] } }).toArray()).map(d => d._id)).toStrictEqual([1, 2])
      })

      it('should reject an empty logical operator array instead of emitting broken SQL', async () => {
        const col = db().collection('i')
        await col.insertMany([{ v: 1 }])

        await expect(col.find({ $or: [] }).toArray()).rejects.toThrow()
        await expect(col.find({ $and: [] }).toArray()).rejects.toThrow()
        await expect(col.find({ $nor: [] }).toArray()).rejects.toThrow()
      })

      it('should reject unknown operators rather than treating them as equality', async () => {
        const col = db().collection('i')
        await col.insertMany([{ qty: 5 }, { qty: 50 }])

        // Silently returning [] for a typo is the worst possible answer here.
        await expect(col.find({ qty: { $gtt: 1 } }).toArray()).rejects.toThrow()
        await expect(col.find({ qty: { $exist: true } }).toArray()).rejects.toThrow()
        // Operators cannot be mixed with plain field names in one criterion
        await expect(col.find({ qty: { $gt: 1, nope: 2 } }).toArray()).rejects.toThrow()
        // ...but a criterion with no operators at all is whole-object equality
        expect(await col.find({ qty: { nope: 2 } }).toArray()).toStrictEqual([])
      })

      it('should reject an array _id', async () => {
        // MongoDB forbids it outright. Here it also made a document ambiguous
        // to address: the implicit array-element rule let { _id: ['x','y'] }
        // match a different document that merely CONTAINS that array, so
        // deleteOne could remove two rows.
        const col = db().collection('i')
        await expect(col.insertOne({ _id: ['x', 'y'] } as any)).rejects.toThrow()
        expect(await col.countDocuments({})).toStrictEqual(0)
      })

      it('should reject operators used as a top-level filter key', async () => {
        const col = db().collection('i')
        await col.insertMany([{ qty: 5 }])

        // `$not` here used to recurse into itself until the stack overflowed
        await expect(col.find({ $not: { qty: 5 } } as any).toArray()).rejects.toThrow()
        await expect(col.find({ $gt: 1 } as any).toArray()).rejects.toThrow()
        await expect(col.find({ $elemMatch: { qty: 5 } } as any).toArray()).rejects.toThrow()
      })
    })
  }
})
