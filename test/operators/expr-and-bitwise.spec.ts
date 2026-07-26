import type { Db as Mdb } from 'mongodb'

import { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * BACKLOG item 8: `$expr` and the `$bits*` operators - the last of the query
 * operator families, apart from `$text` (a decision rather than a build; see
 * the backlog) and `$where` (never).
 */

const accounts = [
  { _id: 1, name: 'ada', spent: 120, budget: 100, flags: 0b1010, tags: ['a', 'b'] },
  { _id: 2, name: 'bob', spent: 40, budget: 100, flags: 0b0101, tags: ['b'] },
  { _id: 3, name: 'cid', spent: 100, budget: 100, flags: 0b1111, tags: [] },
  { _id: 4, name: 'dee', spent: 10, budget: 5, flags: 0, tags: ['a', 'b', 'c'] },
  { _id: 5, name: 'eve', flags: 20.5 }, // no spent or budget, and a non-integer
  { _id: 6, name: 'fay', spent: 'lots', budget: 100, flags: [1, 8] } // a string, and an array
]

describe('$expr and the bitwise operators', () => {
  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('accounts').insertMany(structuredClone(accounts) as any[])
    await mongo().collection('accounts').insertMany(structuredClone(accounts) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    const ids = async (filter: any): Promise<any[]> =>
      (await db().collection('accounts').find(filter).toArray()).map(d => d._id).toSorted()

    describe(dbName, () => {
      describe('$expr', () => {
        it('compares two fields of the same document', async () => {
          // The thing no ordinary filter can express. Document 6 is in the $gt
          // set because its `spent` is the STRING 'lots', and every string
          // sorts above every number in BSON order - the comparison operators
          // order across types rather than refusing to.
          expect(await ids({ $expr: { $gt: ['$spent', '$budget'] } })).toStrictEqual([1, 4, 6])
          expect(await ids({ $expr: { $lt: ['$spent', '$budget'] } })).toStrictEqual([2])
          // Document 5 has NEITHER field: missing equals missing.
          expect(await ids({ $expr: { $eq: ['$spent', '$budget'] } })).toStrictEqual([3, 5])
        })

        it('runs the whole expression language, not just comparison', async () => {
          expect(await ids({ $expr: { $gte: [{ $size: { $ifNull: ['$tags', []] } }, 2] } }))
            .toStrictEqual([1, 4])
          expect(await ids({ $expr: { $eq: [{ $toUpper: '$name' }, 'ADA'] } })).toStrictEqual([1])
          expect(await ids({
            $expr: {
              $switch: {
                branches: [{ case: { $gt: ['$spent', 100] }, then: true }],
                default: false
              }
            }
          })).toStrictEqual([1, 6])
        })

        it('does arithmetic between fields', async () => {
          const col = db().collection('ledger')
          await col.insertMany([
            { _id: 1, debit: 100, credit: 40 },
            { _id: 2, debit: 20, credit: 20 },
            { _id: 3, debit: 5, credit: 90 }
          ] as any[])
          const found = async (filter: any): Promise<any[]> =>
            (await col.find(filter).toArray()).map(d => d._id).toSorted()

          expect(await found({ $expr: { $gt: [{ $subtract: ['$debit', '$credit'] }, 0] } }))
            .toStrictEqual([1])
          expect(await found({ $expr: { $gte: [{ $add: ['$debit', '$credit'] }, 40] } }))
            .toStrictEqual([1, 2, 3])
          expect(await found({ $expr: { $eq: [{ $mod: ['$debit', 20] }, 0] } }))
            .toStrictEqual([1, 2])
          await col.drop()
        })

        it('matches on truthiness, so a bare field path works', async () => {
          // flags: 0 is falsy and a missing field is falsy; 20.5 and an array
          // are truthy.
          expect(await ids({ $expr: '$flags' })).toStrictEqual([1, 2, 3, 5, 6])
          expect(await ids({ $expr: { $not: ['$flags'] } })).toStrictEqual([4])
        })

        it('combines with ordinary filters and the logical operators', async () => {
          expect(await ids({ budget: 100, $expr: { $gt: ['$spent', '$budget'] } })).toStrictEqual([1, 6])
          expect(await ids({
            $or: [{ $expr: { $gt: ['$spent', '$budget'] } }, { name: 'bob' }]
          })).toStrictEqual([1, 2, 4, 6])
          expect(await ids({
            $and: [{ $expr: { $lte: ['$spent', '$budget'] } }, { $expr: { $gt: ['$spent', 50] } }]
          })).toStrictEqual([3])
        })

        it('sees a missing field as missing, not as null or zero', async () => {
          expect(await ids({ $expr: { $eq: [{ $type: '$spent' }, 'missing'] } })).toStrictEqual([5])
          expect(await ids({ $expr: { $eq: ['$spent', null] } })).toStrictEqual([])
        })

        it('compares Dates, which survive the trip into the expression', async () => {
          const col = db().collection('events')
          await col.insertMany([
            { _id: 1, start: new Date('2021-01-01T00:00:00Z'), end: new Date('2021-06-01T00:00:00Z') },
            { _id: 2, start: new Date('2022-01-01T00:00:00Z'), end: new Date('2021-01-01T00:00:00Z') }
          ] as any[])

          expect((await col.find({ $expr: { $lt: ['$start', '$end'] } }).toArray()).map(d => d._id))
            .toStrictEqual([1])
          // A Date in the expression itself, not just in the document.
          expect((await col.find({
            $expr: { $gt: ['$start', new Date('2021-06-01T00:00:00Z')] }
          }).toArray()).map(d => d._id)).toStrictEqual([2])
          await col.drop()
        })

        it('works in countDocuments and in a pipeline $match', async () => {
          expect(await db().collection('accounts').countDocuments({ $expr: { $gt: ['$spent', '$budget'] } }))
            .toStrictEqual(3)
          expect(await db().collection('accounts').aggregate([
            { $match: { $expr: { $gt: ['$spent', '$budget'] } } },
            { $project: { _id: 1 } },
            { $sort: { _id: 1 } }
          ]).toArray()).toStrictEqual([{ _id: 1 }, { _id: 4 }, { _id: 6 }])
        })

        it('rejects an unknown expression operator instead of matching nothing', async () => {
          await expect(db().collection('accounts').find({ $expr: { $gtt: ['$spent', 1] } }).toArray())
            .rejects.toThrow()
          await expect(db().collection('accounts').find({ $expr: { $add: [{ $nope: 1 }, 2] } }).toArray())
            .rejects.toThrow()
        })

        it('is not allowed as a field criterion', async () => {
          await expect(db().collection('accounts').find({ spent: { $expr: 1 } } as any).toArray())
            .rejects.toThrow()
        })
      })

      describe('$bitsAllSet / $bitsAnySet / $bitsAllClear / $bitsAnyClear', () => {
        //  1: 1010    2: 0101    3: 1111    4: 0000    5: 20.5    6: [1, 8]
        it('takes a bitmask', async () => {
          expect(await ids({ flags: { $bitsAllSet: 0b1010 } })).toStrictEqual([1, 3])
          expect(await ids({ flags: { $bitsAnySet: 0b1010 } })).toStrictEqual([1, 3, 6])
          expect(await ids({ flags: { $bitsAllClear: 0b1010 } })).toStrictEqual([2, 4, 6])
          expect(await ids({ flags: { $bitsAnyClear: 0b1010 } })).toStrictEqual([2, 4, 6])
          expect(await ids({ flags: { $bitsAnySet: 0b0100 } })).toStrictEqual([2, 3])
          expect(await ids({ flags: { $bitsAllSet: 0b1111 } })).toStrictEqual([3])
        })

        it('takes an array of bit positions', async () => {
          expect(await ids({ flags: { $bitsAllSet: [1, 3] } })).toStrictEqual([1, 3])
          expect(await ids({ flags: { $bitsAnySet: [0] } })).toStrictEqual([2, 3, 6])
          expect(await ids({ flags: { $bitsAllClear: [1, 3] } })).toStrictEqual([2, 4, 6])
          // An empty position list is a zero mask: every testable value has all
          // of no bits set, and none of them set.
          expect(await ids({ flags: { $bitsAllSet: [] } })).toStrictEqual([1, 2, 3, 4, 6])
          expect(await ids({ flags: { $bitsAnySet: [] } })).toStrictEqual([])
        })

        it('only tests whole numbers, and skips everything else', async () => {
          // 20.5 has no bits to speak of, and neither does a string or a
          // missing field - none of them match even a mask of every bit.
          expect(await ids({ flags: { $bitsAnySet: 4294967295 } })).toStrictEqual([1, 2, 3, 6])
          expect(await ids({ name: { $bitsAnySet: 0b1111 } })).toStrictEqual([])
          expect(await ids({ missingEverywhere: { $bitsAllClear: 0b1 } })).toStrictEqual([])
        })

        it('follows the implicit-array rule, like every other operator', async () => {
          // Document 6's flags is [1, 8]: one ELEMENT with the bit set matches.
          expect(await ids({ flags: { $bitsAllSet: 0b1000 } })).toStrictEqual([1, 3, 6])
          expect(await ids({ flags: { $bitsAllSet: [0] } })).toStrictEqual([2, 3, 6])
        })

        it('works on high bits, past what a JavaScript number holds exactly', async () => {
          const col = db().collection('wide')
          await col.insertMany([{ _id: 1, n: 2 ** 40 }, { _id: 2, n: 1 }] as any[])
          expect((await col.find({ n: { $bitsAllSet: [40] } }).toArray()).map(d => d._id))
            .toStrictEqual([1])
          expect((await col.find({ n: { $bitsAnySet: [40, 0] } }).toArray()).map(d => d._id).toSorted())
            .toStrictEqual([1, 2])
          await col.drop()
        })

        it('rejects a malformed mask', async () => {
          for (const bad of [{ $bitsAllSet: -1 }, { $bitsAllSet: 1.5 }, { $bitsAnySet: [-1] }, { $bitsAnySet: 'nope' }]) {
            await expect(db().collection('accounts').find({ flags: bad } as any).toArray()).rejects.toThrow()
          }
        })

        it('combines with $not and with other operators on the same field', async () => {
          expect(await ids({ flags: { $not: { $bitsAllSet: 0b1010 } } })).toStrictEqual([2, 4, 5, 6])
          expect(await ids({ flags: { $bitsAnySet: 0b1010, $lt: 12 } })).toStrictEqual([1, 6])
        })
      })
    })
  }

  /**
   * The one place `$expr` does not match the server: an evaluation error
   * against one document is caught and means "no match", where MongoDB fails
   * the whole query. It began as a platform necessity - Node 22, a floor this
   * package once had, swallowed exceptions thrown from `db.function()`
   * callbacks (the same trap that shaped the update guards - see CLAUDE.md) -
   * and is KEPT as a choice: one bad document does not veto a query over a
   * schema-less store, and a future driver without user-defined functions
   * (DR-3) could not surface the error either.
   *
   * MongoDB fails the whole query instead, so there is nothing to compare
   * against here and this half runs against this library alone.
   */
  describe('divergence: an expression that raises on some document', () => {
    let db: Db

    beforeEach(async () => {
      db = await Db.fromUrl(':memory:')
      await db.collection('t').insertMany([
        { _id: 1, qty: 10 },
        { _id: 2, qty: 'not a number' }, // $multiply raises on this one
        { _id: 3, qty: 30 }
      ] as any)
    })

    afterEach(async () => { await db.close() })

    it('skips the document rather than failing the query', async () => {
      // A real server answers "Executor error during find command" for this.
      // Here documents 1 and 3 answer normally and document 2 simply does not
      // match, rather than taking the query down with it.
      const found = await db.collection('t').find({
        $expr: { $gt: [{ $multiply: ['$qty', 2] }, 15] }
      }).toArray()
      expect(found.map(d => d._id)).toStrictEqual([1, 3])
    })

    it('still rejects a STRUCTURAL mistake, which is checked before the query runs', async () => {
      // The common typo has to be an error on every supported runtime, so the
      // operator names are validated at compile time rather than per row.
      await expect(db.collection('t').find({ $expr: { $multiplyy: ['$qty', 2] } }).toArray())
        .rejects.toThrow(/unsupported aggregation expression operator: \$multiplyy/)
    })
  })

  /**
   * `$text` and `$where` are DECISIONS, not gaps, so they say why rather than
   * answering "unknown top level operator" - and each names what to reach for
   * instead. This library alone: the point is the error message.
   */
  describe('the two query operators this library refuses', () => {
    let db: Db

    beforeEach(async () => {
      db = await Db.fromUrl(':memory:')
      await db.collection('t').insertOne({ _id: 1, body: 'a cup of coffee' } as any)
    })

    afterEach(async () => { await db.close() })

    it('explains why $text is refused, and what to use instead', async () => {
      await expect(db.collection('t').find({ $text: { $search: 'coffee' } } as any).toArray())
        .rejects.toThrow(/\$text is not supported.*FTS5 stemmer.*\$regex.*db\.sql/s)
      // The alternative it points at does work.
      expect((await db.collection('t').find({ body: { $regex: 'coffee' } }).toArray()).map(d => d._id))
        .toStrictEqual([1])
    })

    it('explains why $where is refused, and points at $expr', async () => {
      await expect(db.collection('t').find({ $where: 'this.body.length > 3' } as any).toArray())
        .rejects.toThrow(/\$where is not supported.*\$expr/s)
      expect((await db.collection('t').find({
        $expr: { $gt: [{ $strLenCP: '$body' }, 3] }
      }).toArray()).map(d => d._id)).toStrictEqual([1])
    })
  })
})
