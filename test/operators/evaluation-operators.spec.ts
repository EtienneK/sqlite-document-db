import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

describe('Evaluation and Element Query Operators - https://www.mongodb.com/docs/manual/reference/operator/query-evaluation/', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('$regex', async () => {
        const p = [
          { _id: 100 as any, sku: 'abc123', description: 'Single line description.' },
          { _id: 101, sku: 'abc789', description: 'First line\nSecond line' },
          { _id: 102, sku: 'xyz456', description: 'Many spaces before     line' },
          { _id: 103, sku: 'xyz789', description: 'Multiple\nline description' },
          { _id: 104, sku: 'Abc789', description: 'SKU starts with A' }
        ]
        const col = db().collection('products')
        await col.insertMany(p)

        // $regex - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/regex/
        expect(await col.find({ sku: { $regex: /789$/ } }).toArray()).toStrictEqual([p[1], p[3], p[4]])
        // Case-insensitive, as RegExp flag and as $options
        expect(await col.find({ sku: { $regex: /^ABC/i } }).toArray()).toStrictEqual([p[0], p[1], p[4]])
        expect(await col.find({ sku: { $regex: '^ABC', $options: 'i' } }).toArray()).toStrictEqual([p[0], p[1], p[4]])
        // Implicit form: { field: /re/ }
        expect(await col.find({ sku: /^ABC/i }).toArray()).toStrictEqual([p[0], p[1], p[4]])
        // Multiline Match for Lines Starting with Specified Pattern
        expect(await col.find({ description: { $regex: /^S/ } }).toArray()).toStrictEqual([p[0], p[4]])
        expect(await col.find({ description: { $regex: /^S/, $options: 'm' } }).toArray()).toStrictEqual([p[0], p[1], p[4]])
        // Use the . Dot Character to Match New Line
        expect(await col.find({ description: { $regex: /m.*line/, $options: 'i' } }).toArray()).toStrictEqual([p[2]])
        expect(await col.find({ description: { $regex: /m.*line/, $options: 'si' } }).toArray()).toStrictEqual([p[2], p[3]])
        // $regex composes with other operators on the same field
        expect(await col.find({ sku: { $regex: /^abc/, $ne: 'abc123' } }).toArray()).toStrictEqual([p[1]])
        // $not with a regex complements the pattern match
        expect(await col.find({ sku: { $not: /^abc/ } }).toArray()).toStrictEqual([p[2], p[3], p[4]])
        expect(await col.find({ sku: { $not: { $regex: '^abc' } } }).toArray()).toStrictEqual([p[2], p[3], p[4]])
        // $in / $nin with regular expressions
        expect(await col.find({ sku: { $in: [/^abc/, /^xyz/] } }).toArray()).toStrictEqual([p[0], p[1], p[2], p[3]])
        expect(await col.find({ sku: { $in: ['Abc789', /^xyz/] } }).toArray()).toStrictEqual([p[2], p[3], p[4]])
        expect(await col.find({ sku: { $nin: [/^abc/, 'xyz456'] } }).toArray()).toStrictEqual([p[3], p[4]])
        // An explicit $eq only matches stored regex VALUES (none can exist
        // here) - it never pattern-matches; other comparisons reject regexes.
        expect(await col.find({ sku: { $eq: /789$/ } }).toArray()).toStrictEqual([])
        await expect(col.find({ sku: { $ne: /789$/ } }).toArray()).rejects.toThrow()
        // Flags in both the RegExp and $options is an error
        await expect(col.find({ sku: { $regex: /^abc/i, $options: 'm' } }).toArray()).rejects.toThrow()
        // $options without $regex is an error
        await expect(col.find({ sku: { $options: 'i' } }).toArray()).rejects.toThrow()
      })

      it('$regex matches array elements and ignores non-strings', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, tags: ['run', 'sing'] },
          { _id: 2, tags: ['climb'] },
          { _id: 3, tags: 'singing' },
          { _id: 4, tags: 42 }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        expect(await col.find({ tags: /^sing/ }).toArray()).toStrictEqual([i[0], i[2]])
        expect(await col.find({ tags: { $regex: /mb$/ } }).toArray()).toStrictEqual([i[1]])
        // Numbers are not stringified and matched
        expect(await col.find({ tags: /4/ }).toArray()).toStrictEqual([])
        // Inside $elemMatch, with and without $options
        expect(await col.find({ tags: { $elemMatch: { $regex: '^sin' } } }).toArray()).toStrictEqual([i[0]])
        expect(await col.find({ tags: { $elemMatch: { $regex: '^SIN', $options: 'i' } } }).toArray()).toStrictEqual([i[0]])
      })

      it('$mod', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, item: 'abc123', qty: 0 },
          { _id: 2, item: 'xyz123', qty: 5 },
          { _id: 3, item: 'mno123', qty: 12 },
          { _id: 4, item: 'dec', qty: 12.5 },
          { _id: 5, item: 'neg', qty: -7 },
          { _id: 6, item: 'arr', qty: [13, 24] },
          { _id: 7, item: 'str', qty: 'twelve' }
        ]
        const col = db().collection('inventory')
        await col.insertMany(i)

        // $mod - Examples from https://www.mongodb.com/docs/manual/reference/operator/query/mod/
        expect(await col.find({ qty: { $mod: [4, 0] } }).toArray()).toStrictEqual([i[0], i[2], i[3], i[5]])
        // Negative dividends keep their (truncated-division) remainder sign
        expect(await col.find({ qty: { $mod: [3, -1] } }).toArray()).toStrictEqual([i[4]])
        expect(await col.find({ qty: { $mod: [3, 2] } }).toArray()).toStrictEqual([i[1]])
        // Floating Point Arguments truncate toward zero
        expect(await col.find({ qty: { $mod: [4.99, 0.9] } }).toArray()).toStrictEqual([i[0], i[2], i[3], i[5]])
        // Not Enough Elements / Too Many Elements / divisor 0 error
        await expect(col.find({ qty: { $mod: [] } }).toArray()).rejects.toThrow()
        await expect(col.find({ qty: { $mod: [4] } }).toArray()).rejects.toThrow()
        await expect(col.find({ qty: { $mod: [4, 0, 0] } }).toArray()).rejects.toThrow()
        await expect(col.find({ qty: { $mod: [0, 0] } }).toArray()).rejects.toThrow()
      })

      it('$type', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, v: 'str' },
          { _id: 2, v: 42 },
          { _id: 3, v: 42.5 },
          { _id: 4, v: true },
          { _id: 5, v: null },
          { _id: 6, v: { nested: 1 } },
          { _id: 7, v: [1, 'two'] },
          { _id: 8, v: new Date('2020-01-02T03:04:05.000Z') },
          { _id: 9 },
          { _id: 10, v: 3000000000 },
          { _id: 11, v: [true, { nested: 2 }, new Date('2021-01-01T00:00:00.000Z')] }
        ]
        const col = db().collection('i')
        await col.insertMany(i)

        // $type - https://www.mongodb.com/docs/manual/reference/operator/query/type/
        // Arrays match when ANY element has the type; missing fields never match.
        expect(await col.find({ v: { $type: 'string' } }).toArray()).toStrictEqual([i[0], i[6]])
        expect(await col.find({ v: { $type: 2 } }).toArray()).toStrictEqual([i[0], i[6]])
        // Integral JS numbers within int32 store as 'int'; others as 'double'
        expect(await col.find({ v: { $type: 'int' } }).toArray()).toStrictEqual([i[1], i[6]])
        expect(await col.find({ v: { $type: 16 } }).toArray()).toStrictEqual([i[1], i[6]])
        expect(await col.find({ v: { $type: 'double' } }).toArray()).toStrictEqual([i[2], i[9]])
        expect(await col.find({ v: { $type: 1 } }).toArray()).toStrictEqual([i[2], i[9]])
        expect(await col.find({ v: { $type: 'number' } }).toArray()).toStrictEqual([i[1], i[2], i[6], i[9]])
        expect(await col.find({ v: { $type: 'bool' } }).toArray()).toStrictEqual([i[3], i[10]])
        expect(await col.find({ v: { $type: 'null' } }).toArray()).toStrictEqual([i[4]])
        // A stored Date is a 'date', never an 'object'
        expect(await col.find({ v: { $type: 'object' } }).toArray()).toStrictEqual([i[5], i[10]])
        expect(await col.find({ v: { $type: 'date' } }).toArray()).toStrictEqual([i[7], i[10]])
        expect(await col.find({ v: { $type: 9 } }).toArray()).toStrictEqual([i[7], i[10]])
        expect(await col.find({ v: { $type: 'array' } }).toArray()).toStrictEqual([i[6], i[10]])
        // Multiple types at once
        expect(await col.find({ v: { $type: ['string', 'bool'] } }).toArray()).toStrictEqual([i[0], i[3], i[6], i[10]])
        // Valid aliases this storage layer can never hold match nothing
        expect(await col.find({ v: { $type: 'long' } }).toArray()).toStrictEqual([])
        expect(await col.find({ v: { $type: 'timestamp' } }).toArray()).toStrictEqual([])
        // Complement via $not (includes missing fields)
        expect(await col.find({ v: { $not: { $type: 'number' } } }).toArray()).toStrictEqual([i[0], i[3], i[4], i[5], i[7], i[8], i[10]])
        // Unknown aliases and codes are errors
        await expect(col.find({ v: { $type: 'foo' } }).toArray()).rejects.toThrow()
        await expect(col.find({ v: { $type: 99 } }).toArray()).rejects.toThrow()
      })
    })
  }
})
