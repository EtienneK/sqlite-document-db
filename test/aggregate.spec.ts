import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { seededDualDbs } from './helpers/dual-dbs.js'

/**
 * The aggregation pipeline subset (BACKLOG item 16).
 *
 * `$group` output order is UNSPECIFIED on the server, so every grouping test
 * here ends with a `$sort` - without one the Mongodb variant is free to
 * disagree with the Sqlite variant for reasons that are nobody's bug.
 */
describe('Aggregation pipeline', () => {
  const orders = [
    { _id: 1 as any, cust: 'ann', item: 'abc', qty: 3, price: 10, tags: ['x', 'y'], at: new Date('2021-01-01T00:00:00Z'), size: { uom: 'cm' } },
    { _id: 2 as any, cust: 'bob', item: 'jkl', qty: 5, price: 2, tags: ['y'], at: new Date('2021-02-01T00:00:00Z'), size: { uom: 'in' } },
    { _id: 3 as any, cust: 'ann', item: 'abc', qty: 1, price: 10, tags: [], at: new Date('2021-03-01T00:00:00Z'), size: { uom: 'cm' } },
    { _id: 4 as any, cust: 'cid', item: 'xyz', qty: 9, price: 7, at: new Date('2021-04-01T00:00:00Z'), size: { uom: 'in' } },
    { _id: 5 as any, cust: 'bob', item: 'xyz', qty: 2, price: 7, tags: ['z', 'x'], at: new Date('2021-01-15T00:00:00Z'), size: { uom: 'cm' } }
  ]

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('orders').insertMany(structuredClone(orders))
    await mongo().collection('orders').insertMany(structuredClone(orders))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const run = async (pipeline: any[]): Promise<any[]> =>
      await (db().collection('orders') as any).aggregate(pipeline).toArray()

    describe(dbName, () => {
      describe('$match / $sort / $limit / $skip', () => {
        it('should filter, sort and limit', async () => {
          const result = await run([{ $match: { qty: { $gte: 3 } } }, { $sort: { qty: -1 } }, { $limit: 2 }])
          expect(result.map(d => d._id)).toStrictEqual([4, 2])
        })

        it('should skip before limiting', async () => {
          const result = await run([{ $sort: { qty: 1 } }, { $skip: 1 }, { $limit: 2 }])
          expect(result.map(d => d.qty)).toStrictEqual([2, 3])
        })

        it('should AND several leading $match stages', async () => {
          const result = await run([{ $match: { cust: 'ann' } }, { $match: { qty: { $gt: 2 } } }])
          expect(result.map(d => d._id)).toStrictEqual([1])
        })

        it('should match on nested and array fields exactly as find() does', async () => {
          expect((await run([{ $match: { 'size.uom': 'in' } }, { $sort: { _id: 1 } }])).map(d => d._id))
            .toStrictEqual([2, 4])
          // Implicit array matching still applies inside a pipeline.
          expect((await run([{ $match: { tags: 'x' } }, { $sort: { _id: 1 } }])).map(d => d._id))
            .toStrictEqual([1, 5])
        })

        it('should sort by a Date', async () => {
          const result = await run([{ $sort: { at: -1 } }, { $limit: 1 }])
          expect(result[0]._id).toStrictEqual(4)
        })

        it('should return every document for an empty pipeline', async () => {
          expect(await run([])).toHaveLength(orders.length)
        })
      })

      describe('$group', () => {
        it('should group by a field and $sum', async () => {
          const result = await run([
            { $group: { _id: '$cust', total: { $sum: '$qty' }, orders: { $sum: 1 } } },
            { $sort: { _id: 1 } }
          ])
          expect(result).toStrictEqual([
            { _id: 'ann', total: 4, orders: 2 },
            { _id: 'bob', total: 7, orders: 2 },
            { _id: 'cid', total: 9, orders: 1 }
          ])
        })

        it('should group everything with _id: null', async () => {
          expect(await run([{ $group: { _id: null, total: { $sum: '$qty' }, avg: { $avg: '$price' } } }]))
            .toStrictEqual([{ _id: null, total: 20, avg: 7.2 }])
        })

        it('should group by a compound _id', async () => {
          const result = await run([
            { $group: { _id: { cust: '$cust', item: '$item' }, n: { $sum: 1 } } },
            { $sort: { '_id.cust': 1, '_id.item': 1 } }
          ])
          expect(result).toStrictEqual([
            { _id: { cust: 'ann', item: 'abc' }, n: 2 },
            { _id: { cust: 'bob', item: 'jkl' }, n: 1 },
            { _id: { cust: 'bob', item: 'xyz' }, n: 1 },
            { _id: { cust: 'cid', item: 'xyz' }, n: 1 }
          ])
        })

        it('should group by a Date, keeping it a Date', async () => {
          const result = await run([{ $group: { _id: '$at', n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 1 }])
          expect(result[0]._id).toBeInstanceOf(Date)
          expect(result[0]._id).toStrictEqual(new Date('2021-01-01T00:00:00Z'))
        })

        it('should support $min, $max, $first and $last', async () => {
          const result = await run([
            { $sort: { _id: 1 } },
            { $group: { _id: '$cust', lo: { $min: '$qty' }, hi: { $max: '$qty' }, first: { $first: '$item' }, last: { $last: '$item' } } },
            { $sort: { _id: 1 } }
          ])
          expect(result).toStrictEqual([
            { _id: 'ann', lo: 1, hi: 3, first: 'abc', last: 'abc' },
            { _id: 'bob', lo: 2, hi: 5, first: 'jkl', last: 'xyz' },
            { _id: 'cid', lo: 9, hi: 9, first: 'xyz', last: 'xyz' }
          ])
        })

        it('should support $push and $addToSet', async () => {
          const result = await run([
            { $sort: { _id: 1 } },
            { $group: { _id: '$item', quantities: { $push: '$qty' }, customers: { $addToSet: '$cust' } } },
            { $sort: { _id: 1 } }
          ])
          expect(result.map(d => ({ _id: d._id, quantities: d.quantities, customers: d.customers.toSorted() })))
            .toStrictEqual([
              { _id: 'abc', quantities: [3, 1], customers: ['ann'] },
              { _id: 'jkl', quantities: [5], customers: ['bob'] },
              { _id: 'xyz', quantities: [9, 2], customers: ['bob', 'cid'] }
            ])
        })

        it('should ignore documents missing the field in $sum and $avg', async () => {
          // Only three documents have a non-empty `tags`; `nope` exists nowhere.
          expect(await run([{ $group: { _id: null, total: { $sum: '$nope' }, avg: { $avg: '$nope' } } }]))
            .toStrictEqual([{ _id: null, total: 0, avg: null }])
        })

        it('should omit missing values from $push', async () => {
          const result = await run([{ $match: { _id: 4 } }, { $group: { _id: null, tags: { $push: '$tags' } } }])
          expect(result).toStrictEqual([{ _id: null, tags: [] }])
        })

        it('should support $count as an accumulator', async () => {
          expect(await run([{ $group: { _id: null, n: { $count: {} } } }])).toStrictEqual([{ _id: null, n: 5 }])
        })

        it('should reject a $group without an _id', async () => {
          await expect(run([{ $group: { total: { $sum: 1 } } }])).rejects.toThrow()
        })
      })

      describe('$project / $addFields', () => {
        it('should include named fields plus _id', async () => {
          expect(await run([{ $match: { _id: 1 } }, { $project: { cust: 1, qty: 1 } }]))
            .toStrictEqual([{ _id: 1, cust: 'ann', qty: 3 }])
        })

        it('should exclude named fields', async () => {
          expect(await run([{ $match: { _id: 4 } }, { $project: { tags: 0, at: 0, price: 0, size: 0 } }]))
            .toStrictEqual([{ _id: 4, cust: 'cid', item: 'xyz', qty: 9 }])
        })

        it('should compute a field from a path, dropping _id when asked', async () => {
          expect(await run([{ $match: { _id: 1 } }, { $project: { who: '$cust', _id: 0 } }]))
            .toStrictEqual([{ who: 'ann' }])
        })

        it('should read a nested path and write a nested one', async () => {
          expect(await run([{ $match: { _id: 1 } }, { $project: { _id: 0, 'unit.of': '$size.uom' } }]))
            .toStrictEqual([{ unit: { of: 'cm' } }])
        })

        it('should support $literal', async () => {
          expect(await run([{ $match: { _id: 1 } }, { $project: { _id: 0, tag: { $literal: '$notAPath' } } }]))
            .toStrictEqual([{ tag: '$notAPath' }])
        })

        it('$addFields should keep the document and add to it', async () => {
          expect(await run([{ $match: { _id: 1 } }, { $addFields: { copy: '$qty' } }, { $project: { qty: 1, copy: 1 } }]))
            .toStrictEqual([{ _id: 1, qty: 3, copy: 3 }])
        })

        it('should reject mixing inclusion and exclusion', async () => {
          await expect(run([{ $project: { cust: 1, qty: 0 } }])).rejects.toThrow()
        })
      })

      describe('$unwind', () => {
        it('should emit one document per array element', async () => {
          const result = await run([{ $match: { _id: 1 } }, { $unwind: '$tags' }, { $project: { tags: 1 } }])
          expect(result).toStrictEqual([{ _id: 1, tags: 'x' }, { _id: 1, tags: 'y' }])
        })

        it('should drop documents whose array is empty or missing', async () => {
          const result = await run([{ $unwind: '$tags' }, { $sort: { _id: 1, tags: 1 } }, { $project: { tags: 1 } }])
          expect(result.map(d => `${String(d._id)}:${String(d.tags)}`))
            .toStrictEqual(['1:x', '1:y', '2:y', '5:x', '5:z'])
        })

        it('should keep them with preserveNullAndEmptyArrays, and report the index', async () => {
          const result = await run([
            { $match: { _id: { $in: [1, 3, 4] } } },
            { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true, includeArrayIndex: 'i' } },
            { $sort: { _id: 1, i: 1 } },
            { $project: { tags: 1, i: 1 } }
          ])
          expect(result).toStrictEqual([
            { _id: 1, tags: 'x', i: 0 },
            { _id: 1, tags: 'y', i: 1 },
            { _id: 3, i: null },
            { _id: 4, i: null }
          ])
        })

        it('should not let one source document share state with its siblings', async () => {
          // A shallow copy would have made every emitted document hold the LAST
          // element, because they would all share the same nested object.
          const result = await run([{ $match: { _id: 5 } }, { $unwind: '$tags' }, { $project: { tags: 1 } }])
          expect(result).toStrictEqual([{ _id: 5, tags: 'z' }, { _id: 5, tags: 'x' }])
        })

        it('should feed $group, which is the point of it', async () => {
          const result = await run([
            { $unwind: '$tags' },
            { $group: { _id: '$tags', n: { $sum: 1 } } },
            { $sort: { _id: 1 } }
          ])
          expect(result).toStrictEqual([{ _id: 'x', n: 2 }, { _id: 'y', n: 2 }, { _id: 'z', n: 1 }])
        })
      })

      describe('$count and mid-pipeline $match', () => {
        it('should count the documents reaching it', async () => {
          expect(await run([{ $match: { qty: { $gt: 1 } } }, { $count: 'n' }])).toStrictEqual([{ n: 4 }])
        })

        it('should emit nothing when the input is empty', async () => {
          expect(await run([{ $match: { qty: { $gt: 999 } } }, { $count: 'n' }])).toStrictEqual([])
        })

        it('should filter the output of $group - the HAVING case', async () => {
          const result = await run([
            { $group: { _id: '$cust', total: { $sum: '$qty' } } },
            { $match: { total: { $gte: 7 } } },
            { $sort: { _id: 1 } }
          ])
          expect(result).toStrictEqual([{ _id: 'bob', total: 7 }, { _id: 'cid', total: 9 }])
        })

        it('should apply full filter semantics after a $group', async () => {
          const result = await run([
            { $group: { _id: '$item', customers: { $addToSet: '$cust' } } },
            { $match: { customers: 'bob' } }, // implicit array matching
            { $sort: { _id: 1 } }
          ])
          expect(result.map(d => d._id)).toStrictEqual(['jkl', 'xyz'])
        })

        it('should sort and limit after a $group', async () => {
          const result = await run([
            { $group: { _id: '$cust', total: { $sum: '$qty' } } },
            { $sort: { total: -1 } },
            { $limit: 2 }
          ])
          expect(result).toStrictEqual([{ _id: 'cid', total: 9 }, { _id: 'bob', total: 7 }])
        })
      })

      describe('cursor behaviour', () => {

        it('should be async-iterable', async () => {
          const seen: unknown[] = []
          for await (const doc of (db().collection('orders') as any).aggregate([{ $match: { cust: 'ann' } }, { $sort: { _id: 1 } }])) {
            seen.push(doc._id)
          }
          expect(seen).toStrictEqual([1, 3])
        })

        it('should return null from next() once exhausted', async () => {
          const cursor = (db().collection('orders') as any).aggregate([{ $match: { _id: 1 } }])
          expect((await cursor.next())._id).toStrictEqual(1)
          expect(await cursor.next()).toBeNull()
          await cursor.close()
        })
      })
    })
  }

  /**
   * This library only: `explain()` reports the SQL/JavaScript boundary, which
   * has no MongoDB counterpart. It is the thing that makes the pushdown a
   * documented property rather than an implementation detail, so it is pinned.
   */
  describe('Sqlite only - pipeline pushdown', () => {
    const collection = (): any => dbs.sqlite().collection('orders')

    it('should push a leading $match, $sort, $skip and $limit into one SELECT', () => {
      const explained = collection().aggregate([
        { $match: { cust: 'ann' } }, { $sort: { qty: 1 } }, { $skip: 1 }, { $limit: 2 }
      ]).explain()
      expect(explained.pushedDown).toStrictEqual(4)
      expect(explained.inJavaScript).toStrictEqual([])
      expect(explained.sql).toContain('LIMIT 2')
      expect(explained.sql).toContain('OFFSET 1')
    })

    it('should stop pushing down at the first stage SQL cannot express', () => {
      const explained = collection().aggregate([
        { $match: { cust: 'ann' } }, { $group: { _id: '$item' } }, { $match: { _id: 'abc' } }, { $sort: { _id: 1 } }
      ]).explain()
      expect(explained.pushedDown).toStrictEqual(1)
      expect(explained.inJavaScript).toStrictEqual(['$group', '$match', '$sort'])
    })

    it('should not push a $match that follows a $sort or $limit', () => {
      // Reordering these would change the answer, so the $match stays in JS.
      expect(collection().aggregate([{ $limit: 2 }, { $match: { cust: 'ann' } }]).explain().inJavaScript)
        .toStrictEqual(['$match'])
      expect(collection().aggregate([{ $sort: { qty: 1 } }, { $match: { cust: 'ann' } }]).explain().inJavaScript)
        .toStrictEqual(['$match'])
    })

    it('should not push a $skip that follows a $limit', () => {
      // MongoDB's $limit-then-$skip takes n and then drops m; LIMIT n OFFSET m
      // does the opposite.
      const explained = collection().aggregate([{ $limit: 3 }, { $skip: 1 }]).explain()
      expect(explained.pushedDown).toStrictEqual(1)
      expect(explained.inJavaScript).toStrictEqual(['$skip'])
    })

    it('should compile a pushed-down $match to the same SQL find() emits', () => {
      // Which is what makes it index-eligible; the plan itself is pinned in
      // test/query-plan.spec.ts.
      const explained = collection().aggregate([{ $match: { qty: { $gte: 3 } } }, { $group: { _id: null } }]).explain()
      expect(explained.pushedDown).toStrictEqual(1)
      expect(explained.sql).toContain('rowid IN')
    })
  })
})
